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
    // We need to know if they exist to decide if this costs a "Seat"
    const existingUser = await this.prisma.user.findUnique({
      where: { email: lowerEmail },
      select: { id: true },
    });

    let isNewSeat = true;

    if (existingUser) {
      // Check if they are already in the Organization (Billing Check)
      const orgMember = await this.prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: { organizationId, userId: existingUser.id },
        },
      });

      if (orgMember) {
        isNewSeat = false; // They are already paying! Don't block them.

        // DUPLICATE CHECK: Are they already in the target?
        if (!workspaceId) {
          throw new ConflictException(
            'User is already a member of this organization',
          );
        } else {
          const wsMember = await this.prisma.workspaceMember.findUnique({
            where: {
              workspaceId_userId: { workspaceId, userId: existingUser.id },
            },
          });
          if (wsMember)
            throw new ConflictException(
              'User is already a member of this workspace',
            );
        }
      }
    }

    // 2. FEATURE GUARD (Only check if it consumes a NEW seat)
    if (isNewSeat) {
      const canInvite = await this.checkCapacity(organizationId);
      if (!canInvite) {
        throw new ForbiddenException(
          'Organization seat limit reached. Upgrade your plan to invite new members.',
        );
      }
    }

    // 3. VALIDATE ROLE SCOPE
    // Prevents assigning an Org Role to a Workspace invite
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new BadRequestException('Invalid Role');

    if (workspaceId && role.scope !== 'WORKSPACE') {
      throw new BadRequestException(
        'Cannot assign Organization Role to Workspace Invite',
      );
    }
    if (!workspaceId && role.scope !== 'ORGANIZATION') {
      throw new BadRequestException(
        'Cannot assign Workspace Role to Organization Invite',
      );
    }

    // 4. CLEAN UP OLD INVITES
    await this.prisma.invitation.deleteMany({
      where: {
        email: lowerEmail,
        organizationId,
        workspaceId, // Matches null if Org invite, or ID if Workspace invite
      },
    });

    // 5. CREATE NEW INVITATION
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 7); // 7 Days

    await this.prisma.invitation.create({
      data: {
        email: lowerEmail,
        organizationId,
        workspaceId,
        roleId,
        inviterId,
        token,
        expiresAt,
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
    // 1. Validate Token
    const invite = await this.prisma.invitation.findUnique({
      where: { token },
    });

    if (!invite || invite.expiresAt < new Date()) {
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

        // Fetch Default System Role
        const sysRole = await tx.role.findFirst({
          where: { name: 'USER', scope: 'SYSTEM' },
        });

        user = await tx.user.create({
          data: {
            email: invite.email,
            password: hashedPassword,
            firstName: data.firstName,
            lastName: data.lastName,
            userType: 'INDIVIDUAL',
            isEmailVerified: true, // Auto-verify since they got the email
            systemRoleId: sysRole.id,
          },
        });
      }

      // B. Add to Organization (Always required)
      const existingOrgMember = await tx.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invite.organizationId,
            userId: user.id,
          },
        },
      });

      if (!existingOrgMember) {
        // If invited to a specific workspace, give 'member' role in Org.
        // If invited to Org directly, give the role specified in invite.
        let orgRoleId = invite.roleId;

        if (invite.workspaceId) {
          const defaultRole = await tx.role.findFirst({
            where: { name: 'MEMBER', scope: 'ORGANIZATION' },
          });
          orgRoleId = defaultRole.id;
        }

        await tx.organizationMember.create({
          data: {
            userId: user.id,
            organizationId: invite.organizationId,
            roleId: orgRoleId,
          },
        });
      }

      // C. Add to Workspace (If applicable)
      if (invite.workspaceId) {
        // Check duplication (Transaction safe)
        const existingWsMember = await tx.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: invite.workspaceId,
              userId: user.id,
            },
          },
        });

        if (!existingWsMember) {
          await tx.workspaceMember.create({
            data: {
              userId: user.id,
              workspaceId: invite.workspaceId,
              roleId: invite.roleId, // Use the role from the invite
            },
          });
        }
      }

      // D. Clean up
      await tx.invitation.delete({ where: { id: invite.id } });

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

    // Regenerate Token & Expiry
    const newToken = crypto.randomBytes(32).toString('hex');
    const newExpiresAt = new Date();
    newExpiresAt.setDate(newExpiresAt.getDate() + 7);

    await this.prisma.invitation.update({
      where: { id: invitationId },
      data: { token: newToken, expiresAt: newExpiresAt },
    });

    // Resend Email
    const context = invitation.workspaceId ? 'workspace' : 'organization';
    //await this.mailService.sendInvite(invitation.email, newToken, context);

    return { message: 'Invitation resent' };
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

    // Unlimited Logic
    if (maxMembers === -1) return true;

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
