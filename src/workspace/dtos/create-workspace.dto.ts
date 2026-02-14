import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class CreateWorkspaceDto {
  @ApiProperty({
    description: 'Name of the workspace',
    example: 'Marketing Team',
  })
  @IsString()
  name: string;

  @ApiPropertyOptional({
    description: 'Unique slug for the workspace Optional',
    example: 'marketing-team',
  })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({
    description: 'Timezone of the workspace',
    example: 'Africa/Lagos',
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Name of the agency client (if workspace is for a client)',
    example: 'Coca-Cola Nigeria',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  agencyClientName?: string | null;

  @ApiPropertyOptional({
    description: 'Status of the agency client',
    example: 'ACTIVE',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  agencyClientStatus?: string | null;

  @ApiPropertyOptional({
    description: 'Contact information for the agency client',
    example: 'client@example.com',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  agencyClientContact?: string | null;

  @ApiPropertyOptional({
    description: 'Hex color associated with the agency client',
    example: '#FF5733',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  agencyClientColor?: string | null;
}
