import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
export class SafeUser {
  @ApiProperty({
    example: '123e4567-e89b-12d3-a456-426614174000',
    description: 'Unique identifier of the user.',
  })
  id: string;

  @ApiProperty({
    example: 'jane.doe@example.com',
    description: 'User email address.',
  })
  email: string;

  @ApiProperty({
    example: 'Jane',
    description: 'First name of the user. Nullable if not provided.',
    nullable: true,
  })
  firstName: string | null;

  @ApiProperty({
    example: 'Doe',
    description: 'Last name of the user. Nullable if not provided.',
    nullable: true,
  })
  lastName: string | null;

  @ApiProperty({
    example: 'https://lh3.googleusercontent.com/a-/AOh14Gh12345xyz',
    description: 'Profile picture URL of the user. Nullable if not provided.',
    nullable: true,
  })
  avatar: string | null;

  @ApiProperty({
    example: 'user',
    description: 'Role assigned to the user (e.g., ADMIN, USER).',
  })
  role: string;

  @ApiProperty({
    example: true,
    description: 'Indicates whether the user’s email has been verified.',
  })
  isEmailVerified: boolean;

  @ApiProperty({
    example: '2025-09-25T10:00:00.000Z',
    description:
      'Timestamp of the user’s last activity. Nullable if user has never logged in.',
    nullable: true,
  })
  lastActiveAt: Date | null;
}

export class AuthResponse {
  @ApiProperty({
    type: SafeUser,
    description: 'Authenticated user details (safe subset).',
  })
  user: SafeUser;

  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token for authenticating requests.',
  })
  accessToken: string;

  @ApiProperty({
    example: 'dGhpc2lzYXJlZnJlc2h0b2tlbg==',
    description: 'JWT refresh token for obtaining new access tokens.',
  })
  refreshToken: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Indicates if the user needs to verify their email.',
  })
  requiresEmailVerification?: boolean;
}
