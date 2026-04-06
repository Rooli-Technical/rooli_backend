import { ApiProperty } from '@nestjs/swagger';

export class OrgPlanDto {
  @ApiProperty({ example: 'clx123plan' })
  id: string;

  @ApiProperty({ example: 'Enterprise' })
  name: string;

  @ApiProperty({
    example: 'ENTERPRISE',
    enum: ['CREATOR', 'BUSINESS', 'ROCKET', 'ENTERPRISE'],
  })
  tier: string;
}

export class OrgOwnerDto {
  @ApiProperty({ example: 'clx1234abc' })
  id: string;

  @ApiProperty({ example: 'John', nullable: true })
  firstName: string | null;

  @ApiProperty({ example: 'Doe', nullable: true })
  lastName: string | null;

  @ApiProperty({ example: 'john@techsolutions.com' })
  email: string;
}

export class AdminOrgListItemDto {
  @ApiProperty({ example: 'clxorg123' })
  id: string;

  @ApiProperty({ example: 'Tech Solutions Inc.' })
  name: string;

  @ApiProperty({ example: '@tech-solutions' })
  slug: string;

  @ApiProperty({ example: 'US' })
  billingCountry: string;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({
    example: 'ACTIVE',
    enum: ['PENDING_PAYMENT', 'ACTIVE', 'SUSPENDED'],
  })
  status: string;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: '2025-01-15T08:00:00.000Z' })
  createdAt: string;

  @ApiProperty({ type: OrgPlanDto, nullable: true })
  plan: OrgPlanDto | null;

  @ApiProperty({
    example: 45,
    description: 'Total number of members in the organization',
  })
  memberCount: number;

  @ApiProperty({ example: 12, description: 'Total number of workspaces' })
  workspaceCount: number;

  @ApiProperty({
    example: 24,
    description: 'Total number of social connections',
  })
  socialCount: number;

  @ApiProperty({ type: OrgOwnerDto, nullable: true })
  owner: OrgOwnerDto | null;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 50 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 3 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNextPage: boolean;

  @ApiProperty({ example: false })
  hasPreviousPage: boolean;
}

export class AdminOrgListResponseDto {
  @ApiProperty({ type: [AdminOrgListItemDto] })
  data: AdminOrgListItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta: PaginationMetaDto;
}

export class SuspendOrgResponseDto {
  @ApiProperty({ example: 'clxorg123' })
  id: string;

  @ApiProperty({ example: 'Tech Solutions Inc.' })
  name: string;

  @ApiProperty({ example: 'SUSPENDED' })
  status: string;

  @ApiProperty({ example: false })
  isActive: boolean;
}

export class ActiveOrgResponseDto {
  @ApiProperty({ example: 'clxorg123' })
  id: string;

  @ApiProperty({ example: 'Tech Solutions Inc.' })
  name: string;

  @ApiProperty({ example: 'ACTIVE' })
  status: string;

  @ApiProperty({ example: true })
  isActive: boolean;
}


export class DeleteOrgResponseDto {
  @ApiProperty({ example: 'clxorg123' })
  id: string;

  @ApiProperty({ example: 'Tech Solutions Inc.' })
  name: string;
}
