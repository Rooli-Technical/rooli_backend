import {
  Injectable,
  ConflictException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { MailService } from '@/mail/mail.service';
import { PrismaService } from '@/prisma/prisma.service';
import { JwtPayload } from '@/auth/interfaces/jwt-payload.interface';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import * as argon2 from 'argon2';
import { randomBytes } from 'crypto';
import { SafeUser } from '@/auth/dtos/AuthResponse.dto';
import { PlanAccessService } from '@/plan-access/plan-access.service';
import { Cron, CronExpression } from '@nestjs/schedule';

@Injectable()
export class InvitationsService {

  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly planAccessService: PlanAccessService,
  ) {}

// ===========================================================================
  // 1. SEND INVITATION
  // ===========================================================================
  async inviteUser(params: {
    inviterId: string;
    organizationId: string;
    email: string;
    roleId?: string; // The role to grant (Org role OR Workspace role)
    workspaceId?: string | null;
  }) {
    const { inviterId, organizationId, roleId, workspaceId } = params;
    const lowerEmail = params.email.toLowerCase();

    // Fetch inviter details first so we can use them in the email
    const inviter = await this.prisma.user.findUniqueOrThrow({
      where: { id: inviterId },
      select: { firstName: true, lastName: true },
    });

    // 1. Validation: Context-Aware Membership Check
    const existingOrgMember = await this.prisma.organizationMember.findFirst({
      where: {
        organizationId,
        user: { email: lowerEmail },
        isActive: true,
      },
    });

    if (workspaceId) {
      // If inviting to a WORKSPACE, only block if they are already in THIS workspace
      const existingWsMember = await this.prisma.workspaceMember.findFirst({
        where: {
          workspaceId,
          member: { user: { email: lowerEmail } },
          isActive: true,
        },
      });

      if (existingWsMember) {
        throw new ConflictException('User is already a member of this workspace.');
      }
    } else {
      // If it's an ORG-WIDE invite, block if they are already in the Org
      if (existingOrgMember) {
        throw new ConflictException('User is already a member of this organization.');
      }
    }

    // 2. Billing: Check seat capacity ONLY if they are a brand new user to the Org
    if (!existingOrgMember) {
      await this.planAccessService.ensureSeatAvailable(
        organizationId,
        lowerEmail,
      );
    }

    // 3. Resolve Role
    // Logic:
    // If workspaceId is present, the roleId refers to a WORKSPACE role.
    // If workspaceId is null, the roleId refers to an ORGANIZATION role.
    let finalRoleId: string;

    if (roleId) {
      const targetRole = await this.prisma.role.findUniqueOrThrow({
        where: { id: roleId },
      });

      // Safety check: ensure role scope matches the target
      const requiredScope = workspaceId ? 'WORKSPACE' : 'ORGANIZATION';
      if (targetRole.scope !== requiredScope) {
        throw new BadRequestException(
          `Role scope mismatch. Expected ${requiredScope} role.`,
        );
      }
      finalRoleId = targetRole.id;
    } else {
      // Default fallback to 'member' if no roleId provided
      const defaultRole = await this.prisma.role.findFirstOrThrow({
        where: {
          slug: 'member', // Ensure you have default roles seeded for both scopes
          scope: workspaceId ? 'WORKSPACE' : 'ORGANIZATION',
          organizationId: null,
        },
      });
      finalRoleId = defaultRole.id;
    }

    // 4. Clean up / Transaction
    const token = randomBytes(32).toString('hex');

    const invitation = await this.prisma.$transaction(async (tx) => {
      // Remove existing pending/declined invites for this specific email+org+workspace combo
      await tx.invitation.deleteMany({
        where: {
          email: lowerEmail,
          organizationId,
          workspaceId: workspaceId || null,
          status: { in: ['PENDING', 'DECLINED'] },
        },
      });

      return tx.invitation.create({
        data: {
          email: lowerEmail,
          token,
          inviterId,
          organizationId,
          workspaceId: workspaceId || null,
          roleId: finalRoleId,
          status: 'PENDING',
        },
        include: {
          organization: { select: { name: true } },
          workspace: { select: { name: true } },
          role: { select: { name: true } },
        },
      });
    });

    const isWorkspace = !!invitation.workspaceId;
    try {
      await this.mailService.sendInvitationEmail({
        to: invitation.email,
        contextName: isWorkspace
          ? invitation.workspace!.name
          : invitation.organization.name,
        inviterName: `${inviter.firstName} ${inviter.lastName}`,
        roleName: invitation.role.name,
        token: invitation.token,
        isWorkspaceInvite: isWorkspace,
        organizationId,
      });
    } catch (error) {
      console.log('Failed to send invitation email. Please try again.');
    }
    
    return {
      message: workspaceId
        ? 'Workspace invitation sent'
        : 'Organization invitation sent',
      invitationId: invitation.id,
    };
  }
  /**
   * 1. GET INVITE DETAILS (Public)
   */
  async getInviteDetails(token: string) {
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
      include: {
        organization: { select: { name: true, slug: true } },
        inviter: { select: { firstName: true, lastName: true } },
        role: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    if (
      !invite ||
      invite.status !== 'PENDING' ||
      invite.createdAt < sevenDaysAgo
    ) {
      throw new BadRequestException('Invitation invalid or expired');
    }

    return {
      email: invite.email,
      organizationName: invite.organization.name,
      workspaceName: invite.workspace?.name || null,
      roleName: invite.role.name,
      invitedBy: `${invite.inviter.firstName} ${invite.inviter.lastName}`,
    };
  }

  async acceptInvite(
    token: string,
    data: { password?: string; firstName?: string; lastName?: string },
  ) {
    // A. Validate Token & Expiry
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
    });

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    if (
      !invite ||
      invite.status !== 'PENDING' ||
      invite.createdAt < sevenDaysAgo
    ) {
      throw new BadRequestException('Invitation invalid or expired');
    }

    // 🚨 CRITICAL FIX 1: The TOCTOU Protection (Check Limits at Acceptance)
    // We pass `invite.email` to exclude THIS specific invite from the "pending" count,
    // ensuring we only block them if the physical active seats are full.
    await this.planAccessService.ensureSeatAvailable(
      invite.organizationId,
      invite.email,
    );

    let isNewUser = false;
    let finalWorkspaceMemberId: string | null = null;

    // B. Main Transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Handle User Account
      let user = await tx.user.findUnique({ where: { email: invite.email } });

      if (!user) {
        isNewUser = true;
        if (!data.password)
          throw new BadRequestException('Password required for new account');

        const hashedPassword = await argon2.hash(data.password);

        user = await tx.user.create({
          data: {
            email: invite.email,
            password: hashedPassword,
            firstName: data.firstName,
            lastName: data.lastName,
            isOnboardingComplete: true, // Bypass onboarding
            isEmailVerified: true,
            // UX Bonus: Set their default dashboard to the workspace they were invited to
            lastActiveWorkspaceId: invite.workspaceId || null,
          },
        });
      }

      // 2. Handle Organization Membership
      let orgMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invite.organizationId,
            userId: user.id,
          },
        },
      });

      if (!orgMember) {
        let orgRoleId = invite.roleId;
        if (invite.workspaceId) {
          const defaultRole = await tx.role.findFirst({
            where: {
              slug: 'org-member',
              scope: 'ORGANIZATION',
              organizationId: null,
            },
          });
          if (!defaultRole) throw new Error('Default Org Role not found');
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

      // 3. Handle Workspace Membership (If applicable)
      if (invite.workspaceId) {
        const existingWsMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_memberId: {
              workspaceId: invite.workspaceId,
              memberId: orgMember.id,
            },
          },
        });

        if (!existingWsMember) {
          const newWsMember = await tx.workspaceMember.create({
            data: {
              workspaceId: invite.workspaceId,
              memberId: orgMember.id,
              roleId: invite.roleId,
            },
          });
          finalWorkspaceMemberId = newWsMember.id;
        } else {
          finalWorkspaceMemberId = existingWsMember.id;
        }
      }

      // 4. Update Invite Status
      const updatedInvite = await tx.invitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      return {
        user,
        invite: updatedInvite,
        workspaceMemberId: finalWorkspaceMemberId,
      };
    });

    // C. Handle Response & Authentication
    if (isNewUser) {
      // 🚨 CRITICAL FIX 2: Inject the Context IDs directly into the Auto-Login JWT
      const tokens = await this.generateTokens(
        result.user.id,
        result.user.email,
        result.invite.organizationId,
        result.invite.workspaceId,
        result.workspaceMemberId,
        result.user.refreshTokenVersion,
      );

      return {
        message: 'Account created and invite accepted',
        ...tokens,
        user: this.toSafeUser(result.user),
      };
    } else {
      // Existing User: Security best practice is forcing them to login with their existing password.
      return {
        message: 'Invite accepted. Please log in to continue.',
        requireLogin: true,
      };
    }
  }

  async resendInvitation(invitationId: string) {
    // 1. Find the invite
    const invite = await this.prisma.invitation.findUnique({
      where: { id: invitationId },
    });

    if (!invite) throw new NotFoundException('Invitation not found');
    if (invite.status === 'ACCEPTED')
      throw new BadRequestException('User already accepted');

    // 2. SAFETY CHECK: Re-verify organization capacity
    // Pass the email to exclude it from the "pending count" since it's already in the DB
    await this.planAccessService.ensureSeatAvailable(
      invite.organizationId,
      invite.email,
    );

    // 3. Refresh Token & Timestamp
    const newToken = crypto.randomBytes(32).toString('hex');

    const updatedInvite = await this.prisma.invitation.update({
      where: { id: invitationId },
      data: {
        token: newToken,
        status: 'PENDING',
        createdAt: new Date(),
      },
      include: {
        inviter: { select: { firstName: true, lastName: true } },
        role: { select: { name: true } },
        organization: { select: { name: true } },
        workspace: { select: { name: true } },
      },
    });
    try {
      // 4. Send Email
      await this.mailService.sendInvitationEmail({
        to: updatedInvite.email,
        contextName: updatedInvite.workspace
          ? updatedInvite.workspace.name
          : updatedInvite.organization.name,
        inviterName: `${updatedInvite.inviter.firstName} ${updatedInvite.inviter.lastName}`,
        roleName: updatedInvite.role.name,
        token: updatedInvite.token,
        isWorkspaceInvite: !!updatedInvite.workspaceId,
        organizationId: invite.organizationId,
      });
    } catch (error) {
      console.log('Failed to resend invitation email. Please try again.');
    }

    return { success: true, message: 'Invitation resent' };
  }

  async revokeInvitation(invitationId: string) {
    // Use delete to keep the DB clean or update status to 'REVOKED' for audit logs
    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    return { message: 'Invitation revoked' };
  }

  async getPendingInvitations(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId, status: 'PENDING' },
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

  private async generateTokens(
    userId: string,
    email: string,
    orgId: string | null,
    workspaceId: string | null,
    workspaceMemberId: string | null,
    version: number,
  ) {
    const payload: JwtPayload = {
      sub: userId,
      email,
      orgId,
      workspaceId,
      workspaceMemberId,
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

  private toSafeUser(user): SafeUser {
    return {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      avatar: user.avatar
        ? {
            ...user.avatar,
            size: user.avatar.size.toString(),
          }
        : null,
      isEmailVerified: user.isEmailVerified,
      lastActiveAt: user.lastActiveAt,
      userType: user.userType,
    };
  }

  //@Cron(CronExpression.EVERY_WEEK)
  async cleanupOldInvitations() {
    this.logger.log('Starting data retention cleanup: Old Invitations...');

    // 1. Calculate the date exactly 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

    try {
      // 2. Perform a bulk delete
      // We safely target anything that is NOT "ACCEPTED" (e.g., PENDING, REVOKED, DECLINED, EXPIRED)
      const result = await this.prisma.invitation.deleteMany({
        where: {
          createdAt: {
            lt: ninetyDaysAgo, // "Less than" means older than 90 days
          },
          status: {
            not: 'ACCEPTED', // Keep accepted ones for your permanent audit trail!
          },
        },
      });

      this.logger.log(`Cleanup complete. Deleted ${result.count} dead invitations.`);
    } catch (error) {
      this.logger.error('Failed to cleanup old invitations', error);
    }
  }
}
