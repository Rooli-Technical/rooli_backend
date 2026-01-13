import { PrismaService } from '@/prisma/prisma.service';
import { DayOfWeek } from '@generated/enums';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';

import { addDays, setHours, setMinutes, isAfter,  } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';

// Helper for Sorting Days
const DAY_ORDER: Record<DayOfWeek, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
  THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
};

@Injectable()
export class QueueService {
  constructor(private prisma: PrismaService) {}

  // ==========================================
  // 1. CRUD OPERATIONS
  // ==========================================

  async addSlot(workspaceId: string, day: DayOfWeek, time: string) {
    // 1. STRICT FORMATTING: Force "09:00" instead of "9:00"
    const timeRegex = /^([0-1][0-9]|2[0-3]):[0-5][0-9]$/;
    if (!timeRegex.test(time)) {
      throw new BadRequestException('Invalid time format. Use HH:mm (e.g., 09:30)');
    }

    const exists = await this.prisma.queueSlot.findFirst({
      where: { workspaceId, dayOfWeek: day, time }
    });
    if (exists) throw new BadRequestException('Slot already exists');

    return this.prisma.queueSlot.create({
      data: { workspaceId, dayOfWeek: day, time }
    });
  }

  async getSlots(workspaceId: string) {
    const slots = await this.prisma.queueSlot.findMany({
      where: { workspaceId }
    });

    // FIX SORTING: JS Sort is safer than DB sort for Enums
    return slots.sort((a, b) => {
      const dayDiff = DAY_ORDER[a.dayOfWeek] - DAY_ORDER[b.dayOfWeek];
      if (dayDiff !== 0) return dayDiff;
      return a.time.localeCompare(b.time); 
    });
  }

  // ==========================================
  // 2. THE ALGORITHM: FIND NEXT SLOT
  // ==========================================

  async getNextAvailableSlot(workspaceId: string): Promise<Date> {
    // A. Fetch Context (Slots + Timezone)
    const workspace = await this.prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { queueSlots: true } // Fetch relation directly
    });

    if (!workspace) throw new NotFoundException('Workspace not found');
    if (workspace.queueSlots.length === 0) {
      throw new BadRequestException('No queue slots defined.');
    }

    // Default to UTC if not set
    const timeZone = workspace.timezone || 'UTC'; 

    // B. Find Reference Date (In UTC)
    const lastScheduledPost = await this.prisma.post.findFirst({
      where: { 
        workspaceId, 
        status: 'SCHEDULED',
        scheduledAt: { not: null }
      },
      orderBy: { scheduledAt: 'desc' },
    });

    // Start looking from either the last post OR "Now"
    let referenceDateUtc = lastScheduledPost?.scheduledAt 
      ? new Date(lastScheduledPost.scheduledAt) 
      : new Date();

    // Safety: If calculating from a previous post, add 1 minute to avoid collision
    if (lastScheduledPost) {
      referenceDateUtc = new Date(referenceDateUtc.getTime() + 60000);
    }

    // C. Calculate
    return this.calculateNextSlot(referenceDateUtc, workspace.queueSlots, timeZone);
  }

  private calculateNextSlot(startDateUtc: Date, slots: any[], timeZone: string): Date {
    // 1. CONVERT UTC START DATE -> WORKSPACE TIME
    // logic: We need to see "What time is it in New York?" to match "Monday 9am"
    const startDateZoned = toZonedTime(startDateUtc, timeZone);

    // Look ahead 14 days
    for (let i = 0; i < 14; i++) {
      const checkDateZoned = addDays(startDateZoned, i);
      const currentDayIndex = checkDateZoned.getDay(); // 0 (Sun) - 6 (Sat) relative to Zoned Time

      // Find slots for this day
      const todaysSlots = slots.filter(s => DAY_ORDER[s.dayOfWeek] === currentDayIndex);
      
      // Sort times (09:00 comes before 14:00)
      todaysSlots.sort((a, b) => a.time.localeCompare(b.time));

      for (const slot of todaysSlots) {
        const [hours, minutes] = slot.time.split(':').map(Number);
        
        // Construct the Slot Date in USER TIMEZONE
        let slotDateZoned = setHours(checkDateZoned, hours);
        slotDateZoned = setMinutes(slotDateZoned, minutes);
        slotDateZoned.setSeconds(0);
        slotDateZoned.setMilliseconds(0);

        // Check if this slot is in the future relative to our start point
        if (isAfter(slotDateZoned, startDateZoned)) {
          
          // 2. CONVERT WORKSPACE TIME -> UTC
          // We must return UTC to store in the DB
          return fromZonedTime(slotDateZoned, timeZone);
        }
      }
    }

    throw new Error('No available slot found in the next 14 days.');
  }

  async deleteSlot(workspaceId: string, slotId: string) {
    const slot = await this.prisma.queueSlot.findFirst({
      where: { id: slotId, workspaceId } 
    });
    
    if (!slot) throw new NotFoundException('Slot not found');

    return this.prisma.queueSlot.delete({
      where: { id: slotId }
    });
  }
}
