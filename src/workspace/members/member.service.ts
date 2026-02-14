// // --------------------------------------------------------
//   // 3. MEMBER MANAGEMENT (Agency Features)
//   // --------------------------------------------------------
//   async addMember(workspaceId: string, dto: AddWorkspaceMemberDto) {
//     // 1. Check Seat Limit (Logic remains valid as it likely checks the Org level)
//     await this.checkSeatLimit(workspaceId, dto.email);

//     // 2. Find the Organization Member record instead of just the User
//     // A user must be in the Org before they can be added to a Workspace
//     const workspace = await this.prisma.workspace.findUnique({
//       where: { id: workspaceId },
//       select: { organizationId: true },
//     });

//     const orgMember = await this.prisma.organizationMember.findFirst({
//       where: {
//         organizationId: workspace.organizationId,
//         user: { email: dto.email },
//       },
//     });

//     if (!orgMember) {
//       throw new NotFoundException(
//         'User is not a member of this organization. Invite them to the organization first.',
//       );
//     }

//     // 3. Check Role Scope
//     const role = await this.prisma.role.findUnique({
//       where: { id: dto.roleId },
//     });
//     if (!role || role.scope !== 'WORKSPACE') {
//       throw new BadRequestException('Role must be Workspace-scoped');
//     }

//     // 4. Add Member using memberId
//     try {
//       return await this.prisma.workspaceMember.create({
//         data: {
//           workspaceId,
//           memberId: orgMember.id, // FIXED: Using memberId
//           roleId: dto.roleId,
//         },
//       });
//     } catch (e: any) {
//       if (e.code === 'P2002')
//         throw new ConflictException('User already in workspace');
//       throw e;
//     }
//   }

//   async removeMember(workspaceId: string, userIdToRemove: string) {
//     // We need to find the memberId for this userId within the workspace's organization
//     const workspace = await this.prisma.workspace.findUnique({
//       where: { id: workspaceId },
//       select: { organizationId: true },
//     });

//     const orgMember = await this.prisma.organizationMember.findUnique({
//       where: {
//         organizationId_userId: {
//           organizationId: workspace.organizationId,
//           userId: userIdToRemove,
//         },
//       },
//     });

//     if (!orgMember) throw new NotFoundException('Member record not found');

//     return this.prisma.workspaceMember.delete({
//       where: {
//         workspaceId_memberId: {
//           workspaceId,
//           memberId: orgMember.id,
//         },
//       },
//     });
//   }