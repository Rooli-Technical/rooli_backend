import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { InviteMemberDto } from './dtos/invite-member.dto';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { InvitationStatus } from '@generated/enums';

const INVITATION_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
  ) {}

  async inviteMember(orgId: string, inviterId: string, dto: InviteMemberDto) {
    const email = dto.email.toLowerCase();

    // 1. Parallel Checks: User Existence & Role Validity
    const [existingUser, role] = await Promise.all([
      this.prisma.user.findUnique({
        where: { email },
        include: {
          organizationMemberships: {
            where: { organizationId: orgId, isActive: true },
          },
        },
      }),
      this.prisma.role.findUnique({ where: { id: dto.roleId } }),
    ]);

    if (!role) throw new BadRequestException('Invalid role specified');

    // 2. Conflict: Is user already a member?
    if (existingUser?.organizationMemberships.length > 0) {
      throw new ConflictException(
        'User is already a member of this organization',
      );
    }

    // 3. Conflict: Is there already a pending invite?
    const existingInvite = await this.prisma.organizationInvitation.findFirst({
      where: {
        organizationId: orgId,
        email: email,
        status: 'PENDING',
        expiresAt: { gt: new Date() }, // Still valid
      },
    });

    if (existingInvite) {
      throw new ConflictException(
        'A pending invitation already exists for this email',
      );
    }

    // 4. Limit Check (Including Pending Invites)
    const canInvite = await this.checkCapacity(orgId);
    if (!canInvite) {
      throw new BadRequestException(
        'Organization member limit reached (including pending invitations)',
      );
    }

    // 5. Create Invitation
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

    const invitation = await this.prisma.organizationInvitation.create({
      data: {
        email: email,
        organizationId: orgId,
        invitedBy: inviterId,
        roleId: role.id,
        token,
        expiresAt,
        message: dto.message,
      },
      include: {
        organization: true,
        inviter: { select: { firstName: true, lastName: true } },
      },
    });

    // 6. Send Email (Async)
    // await this.mailService.sendInvitationEmail({...});

    return invitation;
  }

  async acceptInvitation(token: string, userId: string) {
    // 1. Validate Invite
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
      include: { role: true },
    });

    if (!invitation || invitation.status !== 'PENDING') {
      throw new NotFoundException('Invalid or inactive invitation');
    }

    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }

    // 2. Validate User Match (Security Critical)
    const user = await this.prisma.user.findUnique({ where: { id: userId } });

    // Case-insensitive comparison is safer
    if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
      throw new BadRequestException(
        'This invitation belongs to a different email address',
      );
    }

    // 3. Double Check Capacity (Race Condition Protection)
    // We strictly count active members now, as this invite transitions from Pending -> Active
    const hasCapacity = await this.checkCapacity(
      invitation.organizationId,
      true,
    );
    if (!hasCapacity) {
      throw new BadRequestException(
        'Organization capacity reached. Contact the admin.',
      );
    }

    // 4. Transaction: Execute Join
    return this.prisma.$transaction(async (tx) => {
      // Create Member
      const membership = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId,
          roleId: invitation.roleId,
          invitedBy: invitation.invitedBy,
        },
      });

      // Update Invite Status
      await tx.organizationInvitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED' },
      });

      return membership;
    });
  }

  async resendInvitation(invitationId: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { id: invitationId },
      include: { organization: true, inviter: true, role: true },
    });

    if (!invitation || invitation.status !== 'PENDING') {
      throw new BadRequestException('Invitation is not pending');
    }

    const newToken = this.generateToken();
    const newExpiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

    const updated = await this.prisma.organizationInvitation.update({
      where: { id: invitationId },
      data: {
        token: newToken,
        expiresAt: newExpiresAt,
        resentAt: new Date(),
      },
    });

    // await this.mailService.sendInvitationEmail(...)

    return updated;
  }

  async revokeInvitation(invitationId: string) {
    return this.prisma.organizationInvitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
  }

  async declineInvitation(token: string) {
    const invitation = await this.prisma.organizationInvitation.findUnique({
      where: { token },
    });

    if (!invitation || invitation.status !== 'PENDING') {
      throw new BadRequestException('Invitation is no longer active');
    }

    return this.prisma.organizationInvitation.update({
      where: { id: invitation.id },
      data: { status: 'DECLINED' },
    });
  }

  async getOrganizationInvitations(orgId: string) {
    return this.prisma.organizationInvitation.findMany({
      where: { organizationId: orgId },
      include: {
        inviter: { select: { firstName: true, lastName: true, email: true } },
        role: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  /**
   * Checks if the organization has space for a new member.
   * Logic: Active Members + Pending Invites < Max Limit
   */
  private async checkCapacity(
    orgId: string,
    skipPendingCount = false,
  ): Promise<boolean> {
    const [subscription, activeCount, pendingCount] = await Promise.all([
      this.prisma.subscription.findUnique({
        where: { organizationId: orgId },
        include: { plan: true },
      }),
      this.prisma.organizationMember.count({
        where: { organizationId: orgId, isActive: true },
      }),
      // Only count pending if we are creating a NEW invite.
      // If we are accepting, the "Pending" slot is technically the one we are claiming.
      skipPendingCount
        ? 0
        : this.prisma.organizationInvitation.count({
            where: {
              organizationId: orgId,
              status: 'PENDING',
              expiresAt: { gt: new Date() },
            },
          }),
    ]);

    // 1. No Active Subscription = No Invitations
    if (!subscription || subscription.status !== 'active') return false;

    // 2. Handle "Unlimited" (-1) logic if your plan supports it
    const maxMembers = subscription.plan.maxTeamMembers;
    if (maxMembers === -1) return true;

    // 3. The Strict Check
    const usedSlots = activeCount + pendingCount;
    return usedSlots < maxMembers;
  }

  private generateToken(): string {
    return randomBytes(32).toString('hex');
  }
}
