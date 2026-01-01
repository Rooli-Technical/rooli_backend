export interface JwtPayload {
  sub: string;
  email: string;
  orgId: string;
  workspaceId: string;
  ver: number; 
  role?: string;
  iat?: number;
  exp?: number;
}
