export interface JwtPayload {
  sub: string;
  email: string;
  orgId: string;
  workspaceId: string;
  workspaceMemberId: string | null;
  ver: number; 
  role?: string;
  iat?: number;
  exp?: number;
}
