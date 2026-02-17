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
import { randomBytes } from 'crypto';
import { isPast } from 'date-fns/isPast';
import { SafeUser } from '@/auth/dtos/AuthResponse.dto';

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
    select: { firstName: true, lastName: true }
  });

  // 1. Validation: Is user already a member of the Org?
  const existingMember = await this.prisma.organizationMember.findFirst({
    where: {
      organizationId,
      user: { email: lowerEmail },
    },
  });
  if (existingMember) {
    throw new ConflictException('User is already a member of this organization.');
  }

  // 2. Billing: Check seat capacity before proceeding
  await this.checkSeatLimit(organizationId, lowerEmail);

  // 3. Resolve Role
  // Logic: 
  // If workspaceId is present, the roleId refers to a WORKSPACE role.
  // If workspaceId is null, the roleId refers to an ORGANIZATION role.
  let finalRoleId: string;

  if (roleId) {
    const targetRole = await this.prisma.role.findUniqueOrThrow({ where: { id: roleId } });
    
    // Safety check: ensure role scope matches the target
    const requiredScope = workspaceId ? 'WORKSPACE' : 'ORGANIZATION';
    if (targetRole.scope !== requiredScope) {
      throw new BadRequestException(`Role scope mismatch. Expected ${requiredScope} role.`);
    }
    finalRoleId = targetRole.id;
  } else {
    // Default fallback to 'member' if no roleId provided
    const defaultRole = await this.prisma.role.findFirstOrThrow({
      where: { 
        slug: 'member', 
        scope: workspaceId ? 'WORKSPACE' : 'ORGANIZATION',
        organizationId: null 
      },
    });
    finalRoleId = defaultRole.id;
  }

  // 4. Clean up / Transaction
  // (email + org + workspace) and create the new one atomically.
  const token = randomBytes(32).toString('hex');

  const invitation = await this.prisma.$transaction(async (tx) => {
    // Remove existing pending/declined invites for this specific email+org+workspace combo
    await tx.invitation.deleteMany({
      where: {
        email: lowerEmail,
        organizationId,
        workspaceId: workspaceId || null,
        status: { in: ['PENDING', 'DECLINED'] }
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
        role: { select: { name: true } }
      }
    });
  });

 const isWorkspace = !!invitation.workspaceId;

  await this.mailService.sendInvitationEmail({
    to: invitation.email,
    contextName: isWorkspace ? invitation.workspace!.name : invitation.organization.name,
    inviterName: `${inviter.firstName} ${inviter.lastName}`,
    roleName: invitation.role.name,
    token: invitation.token,
    isWorkspaceInvite: isWorkspace,
  });
  return { 
    message: workspaceId ? 'Workspace invitation sent' : 'Organization invitation sent',
    invitationId: invitation.id 
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

    if (!invite || invite.status !== 'PENDING' || invite.createdAt < sevenDaysAgo) {
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

    if (!invite || invite.status !== 'PENDING' || invite.createdAt < sevenDaysAgo) {
      throw new BadRequestException('Invitation invalid or expired');
    }

    // B. Main Transaction
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Handle User Account
      let user = await tx.user.findUnique({ where: { email: invite.email } });

      if (!user) {
        if (!data.password) throw new BadRequestException('Password required for new account');
        const hashedPassword = await argon2.hash(data.password);
        
        user = await tx.user.create({
          data: {
            email: invite.email,
            password: hashedPassword,
            firstName: data.firstName,
            lastName: data.lastName,
            isOnboardingComplete: true, // They bypass onboarding via invite
            isEmailVerified: true,
          },
        });
      }

      // 2. Handle Organization Membership
      let orgMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId: invite.organizationId, userId: user.id },
        },
      });

      if (!orgMember) {
        // Resolve Org Role: If invited to workspace, they get default 'member' in Org
        let orgRoleId = invite.roleId;
        if (invite.workspaceId) {
          const defaultRole = await tx.role.findFirst({
            where: { slug: 'member', scope: 'ORGANIZATION', organizationId: null },
          });
          if (!defaultRole) throw new Error("Default Org Role not found");
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
            workspaceId_memberId: { workspaceId: invite.workspaceId, memberId: orgMember.id },
          },
        });

        if (!existingWsMember) {
          await tx.workspaceMember.create({
            data: {
              workspaceId: invite.workspaceId,
              memberId: orgMember.id,
              roleId: invite.roleId, // The role specified in the invite (Workspace-scoped)
            },
          });
        }
      }

      // 4. Update Invite Status
      const updatedInvite = await tx.invitation.update({
        where: { id: invite.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      return { user, invite: updatedInvite };
    });

    // C. Generate Auto-Login Tokens
    return {
      ...(await this.generateTokens(
        result.user.id,
        result.user.email,
        result.invite.organizationId,
        result.invite.workspaceId,
        result.user.refreshTokenVersion,
      )),
      user: this.toSafeUser(result.user),
    };
  }

  async resendInvitation(invitationId: string) {
  // 1. Find the invite
  const invite = await this.prisma.invitation.findUnique({
    where: { id: invitationId },
  });

  if (!invite) throw new NotFoundException('Invitation not found');
  if (invite.status === 'ACCEPTED') throw new BadRequestException('User already accepted');

  // 2. SAFETY CHECK: Re-verify organization capacity
  // Pass the email to exclude it from the "pending count" since it's already in the DB
  await this.checkSeatLimit(invite.organizationId, invite.email);

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
      workspace: { select: { name: true } }
    }
  });

  // 4. Send Email   
await this.mailService.sendInvitationEmail({
    to: updatedInvite.email,
    contextName: updatedInvite.workspace ? updatedInvite.workspace.name : updatedInvite.organization.name,
    inviterName: `${updatedInvite.inviter.firstName} ${updatedInvite.inviter.lastName}`,
    roleName: updatedInvite.role.name,
    token: updatedInvite.token,
    isWorkspaceInvite: !!updatedInvite.workspaceId,
  });

  return { success: true, message: 'Invitation resent' };
}

async revokeInvitation(invitationId: string) {
  // Use delete to keep the DB clean or update status to 'REVOKED' for audit logs
  await this.prisma.invitation.update({
    where: { id: invitationId },
    data: { status: 'REVOKED', revokedAt: new Date() }
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
  private async checkSeatLimit(organizationId: string, excludeEmail?: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: { subscription: { include: { plan: true } } },
    });

    if (!org) throw new NotFoundException('Organization not found');

    // Default to 1 seat if no plan exists (Safety fallback)
    const limit = org.subscription?.plan?.maxTeamMembers || 1;
    
    // Handle Unlimited
    if (limit === -1 || limit >= 9999) return; 

    // Count Active Members
    const activeMembers = await this.prisma.organizationMember.count({
      where: { organizationId },
    });

    // Count Pending Invites (excluding the current user if resending)
    const pendingInvites = await this.prisma.invitation.count({
      where: { 
        organizationId, 
        status: 'PENDING',
        email: excludeEmail ? { not: excludeEmail } : undefined 
      },
    });

    if ((activeMembers + pendingInvites) >= limit) {
      throw new ForbiddenException(
        `Seat limit reached (${limit}). Upgrade your plan to invite more team members.`
      );
    }
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

    private toSafeUser(user): SafeUser {
      return {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        avatar: user.avatar,
        isEmailVerified: user.isEmailVerified,
        lastActiveAt: user.lastActiveAt,
        userType: user.userType,
      };
    }
  
}
