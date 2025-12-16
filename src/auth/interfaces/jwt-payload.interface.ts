export interface JwtPayload {
  sub: string;
  email: string;
  timezone: string
  orgId: string
  ver: number; 
  role?: string;
  iat?: number;
  exp?: number;
}
