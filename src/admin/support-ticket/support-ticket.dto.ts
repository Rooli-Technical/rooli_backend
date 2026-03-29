import { TicketCategory, TicketPriority, TicketStatus } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

// ─── Create ───────────────────────────────────────────────────────────────────

export class CreateTicketDto {
  @ApiProperty({
    example: "Can't connect Meta Business account",
    minLength: 5,
    maxLength: 150,
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(150)
  title: string;

  @ApiProperty({
    example: "I keep getting 'OAuth error: permissions denied'...",
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  description: string;

  @ApiPropertyOptional({ enum: TicketPriority, default: TicketPriority.MEDIUM })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ enum: TicketCategory, default: TicketCategory.OTHER })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @ApiProperty({
    description: 'WorkspaceMember ID of the requester',
    example: 'clx1234abcd',
  })
  @IsString()
  @IsNotEmpty()
  requesterId: string;

  @ApiProperty({ example: 'clxworkspace123' })
  @IsString()
  @IsNotEmpty()
  workspaceId: string;
}

// ─── Update ───────────────────────────────────────────────────────────────────

export class UpdateTicketDto extends PartialType(CreateTicketDto) {
  @ApiPropertyOptional({ enum: TicketStatus })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({
    description: 'Admin/agent user ID. Pass null to unassign.',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  assigneeId?: string | null;
}

// ─── Assign ───────────────────────────────────────────────────────────────────

export class AssignTicketDto {
  @ApiProperty({
    description: 'User ID of the admin/agent to assign',
    example: 'clxadmin456',
  })
  @IsString()
  @IsNotEmpty()
  assigneeId: string;
}

// ─── Query / Filter ───────────────────────────────────────────────────────────

export class QueryTicketsDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  workspaceId?: string;

  @ApiPropertyOptional({ enum: TicketStatus })
  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @ApiPropertyOptional({ enum: TicketPriority })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ enum: TicketCategory })
  @IsOptional()
  @IsEnum(TicketCategory)
  category?: TicketCategory;

  @ApiPropertyOptional({ description: 'Filter by assignee user ID' })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: 'Search in title and description' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─── Comment ──────────────────────────────────────────────────────────────────

export class AddCommentDto {
  @ApiProperty({
    example: "Hi! I can see your account and I'm looking into this now.",
  })
  @IsString()
  @IsNotEmpty()
  body: string;

  @ApiPropertyOptional({
    description: 'Internal note — only visible to support agents',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  isInternal?: boolean = false;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaFileIds?: string[];
}
