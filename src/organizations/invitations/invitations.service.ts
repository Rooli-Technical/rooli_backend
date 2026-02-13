import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtPayload } from '@/auth/interfaces/jwt-payload.interface';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  // ===========================================================================
  // 1. SEND INVITATION
  // ===========================================================================
  // invitations.service.ts

 async inviteUser(
  inviterId: string,
  organizationId: string,
  email: string,
  roleId: string,
  workspaceId: string | null = null,
) {
  const lowerEmail = email.toLowerCase();

  // 1. CHECK EXISTING USER & MEMBERSHIP
  const existingUser = await this.prisma.user.findUnique({
    where: { email: lowerEmail },
    select: { id: true },
  });

  let isNewSeat = true;

  if (existingUser) {
    const orgMember = await this.prisma.organizationMember.findUnique({
      where: {
        organizationId_userId: { organizationId, userId: existingUser.id },
      },
    });

    if (orgMember) {
      isNewSeat = false; 

      if (!workspaceId) {
        throw new ConflictException('User is already in this organization');
      } else {
        // FIXED: Check WorkspaceMember via the OrganizationMember ID
        const wsMember = await this.prisma.workspaceMember.findUnique({
          where: {
            workspaceId_memberId: { 
              workspaceId, 
              memberId: orgMember.id 
            },
          },
        });
        if (wsMember) throw new ConflictException('User is already in this workspace');
      }
    }
  }

  // 2. FEATURE GUARD (Seats)
  if (isNewSeat) {
    const canInvite = await this.checkCapacity(organizationId);
    if (!canInvite) {
      throw new ForbiddenException('Seat limit reached. Upgrade your plan.');
    }
  }

  // 3. VALIDATE ROLE SCOPE
  const role = await this.prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new BadRequestException('Invalid Role');

  if (workspaceId && role.scope !== 'WORKSPACE') {
    throw new BadRequestException('Use a Workspace Role for workspace invites');
  }
  if (!workspaceId && role.scope !== 'ORGANIZATION') {
    throw new BadRequestException('Use an Organization Role for organization invites');
  }

  // 4. CLEAN UP OLD INVITES
  // Prisma will match null workspaceId correctly here
  await this.prisma.invitation.deleteMany({
    where: {
      email: lowerEmail,
      organizationId,
      workspaceId, 
    },
  });

  // 5. CREATE NEW INVITATION
  const token = crypto.randomBytes(32).toString('hex');
  // Note: expiresAt was dropped in your migration script. 
  // We use status PENDING and updatedAt (calculated in app logic if needed)

  await this.prisma.invitation.create({
    data: {
      email: lowerEmail,
      organizationId,
      workspaceId,
      roleId,
      inviterId,
      token,
      status: 'PENDING', // Uses the new InvitationStatus enum
    },
  });

  // 6. SEND EMAIL
  // await this.mailService.sendInvite(...)

  return { message: 'Invitation sent successfully' };
}

  // ===========================================================================
  // 2. ACCEPT INVITATION
  // ===========================================================================
 async acceptInvite(
  token: string,
  data: { password?: string; firstName?: string; lastName?: string },
) {
  // 1. Validate Token (Using status and timing since expiresAt is gone)
  const invite = await this.prisma.invitation.findUnique({
    where: { token },
  });

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  if (!invite || invite.status !== 'PENDING' || invite.createdAt < sevenDaysAgo) {
    throw new BadRequestException('Invitation invalid or expired');
  }

  let user = await this.prisma.user.findUnique({
    where: { email: invite.email },
  });

  // 2. Transaction: Create/Link User & Delete Invite
  const result = await this.prisma.$transaction(async (tx) => {
    // A. Create User if New
    if (!user) {
      if (!data.password)
        throw new BadRequestException('Password required for new account');
      const hashedPassword = await argon2.hash(data.password);

      // Note: systemRoleId removed from User model per your migration
      user = await tx.user.create({
        data: {
          email: invite.email,
          password: hashedPassword,
          firstName: data.firstName,
          lastName: data.lastName,
          userType: 'INDIVIDUAL',
          isEmailVerified: true,
        },
      });
    }

    // B. Add/Get Organization Membership
    let orgMember = await tx.organizationMember.findUnique({
      where: {
        organizationId_userId: {
          organizationId: invite.organizationId,
          userId: user.id,
        },
      },
    });

    if (!orgMember) {
      // If invited to a specific workspace, give a default 'MEMBER' role in Org.
      // If invited to Org directly (workspaceId is null), use the role from the invite.
      let orgRoleId = invite.roleId;

      if (invite.workspaceId) {
        const defaultRole = await tx.role.findFirst({
          where: { 
            name: { in: ['MEMBER', 'Member', 'member'] }, 
            scope: 'ORGANIZATION',
            organizationId: null // System-level default role
          },
        });
        if (!defaultRole) throw new Error("Default Organization Member role not found.");
        orgRoleId = defaultRole.id;
      }

      orgMember = await tx.organizationMember.create({
        data: {
          userId: user.id,
          organizationId: invite.organizationId,
          roleId: orgRoleId,
        },
      });
    }

    // C. Add to Workspace (If applicable)
    if (invite.workspaceId) {
      // FIXED: Check WorkspaceMember using memberId instead of userId
      const existingWsMember = await tx.workspaceMember.findUnique({
        where: {
          workspaceId_memberId: {
            workspaceId: invite.workspaceId,
            memberId: orgMember.id, // Linked to the Org Member we just found/created
          },
        },
      });

      if (!existingWsMember) {
        await tx.workspaceMember.create({
          data: {
            workspaceId: invite.workspaceId,
            memberId: orgMember.id, // Using new schema link
            roleId: invite.roleId,  // The Workspace Role specified in invite
          },
        });
      }
    }

    // D. Update invitation status instead of simple delete (for audit logs)
    await tx.invitation.update({
      where: { id: invite.id },
      data: { 
        status: 'ACCEPTED', 
        acceptedAt: new Date() 
      }
    });

    return user;
  });

  // 3. Generate Auto-Login Tokens
  return this.generateTokens(
    result.id,
    result.email,
    invite.organizationId,
    invite.workspaceId || null,
    0,
  );
}

  // ===========================================================================
  // 3. MANAGEMENT (Resend / Revoke / List)
  // ===========================================================================

async resendInvitation(invitationId: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invitation) throw new NotFoundException('Invitation not found');

    // 1. Regenerate Token
    const newToken = crypto.randomBytes(32).toString('hex');

    // 2. Update the invitation
    // Note: expiresAt is removed. We update 'status' and 'createdAt' 
    // to reset the 7-day window.
    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { 
        token: newToken, 
        status: 'PENDING',
        createdAt: new Date(), // Resetting the clock for the 7-day expiry logic
        updatedAt: new Date(),
      },
    });

    // 3. Resend Email Logic
    const context = invitation.workspaceId ? 'workspace' : 'organization';
    // await this.mailService.sendInvite(invitation.email, newToken, context);

    return { message: 'Invitation resent successfully' };
  } 

  async revokeInvitation(invitationId: string) {
    // We just delete it. "Revoked" status is usually unnecessary complexity.
    await this.prisma.invitation.delete({
      where: { id: invitationId },
    });
    return { message: 'Invitation revoked' };
  }

  async getPendingInvitations(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId },
      include: {
        role: { select: { name: true } },
        workspace: { select: { name: true } }, // Show which workspace they are invited to
        inviter: { select: { firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ===========================================================================
  // 4. HELPERS & GUARDS
  // ===========================================================================

  /**
   * The "Feature Guard" logic.
   * Checks if Org has space for more members based on Plan.
   */
  private async checkCapacity(orgId: string): Promise<boolean> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { organizationId: orgId },
      include: { plan: true, organization: { include: { members: true } } },
    });

    if (!subscription || subscription.status !== 'active') return false;

    const maxMembers = subscription.plan.maxTeamMembers;


    // Count Active Members + Pending Invites
    const activeCount = await this.prisma.organizationMember.count({
      where: { organizationId: orgId },
    });
    const pendingCount = await this.prisma.invitation.count({
      where: { organizationId: orgId },
    });

    return activeCount + pendingCount < maxMembers;
  }

  private async generateTokens(
    userId: string,
    email: string,
    orgId: string | null,
    workspaceId: string | null,
    version: number,
  ) {
    const payload: JwtPayload = {
      sub: userId,
      email,
      orgId,
      workspaceId,
      ver: version,
    };
    const [at, rt] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_SECRET'),
        expiresIn: '15m',
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get('JWT_REFRESH_SECRET'),
        expiresIn: '7d',
      }),
    ]);
    return { accessToken: at, refreshToken: rt };
  }
}
