// src/inbox/dto/list-inbox-conversations.dto.ts
import { IsArray, IsDateString, IsEnum, IsInt, IsOptional, IsString, Max, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

export enum InboxOrderBy {
  lastMessageAt = 'lastMessageAt',
}

export class ListInboxConversationsDto {
  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  socialProfileId?: string;

  @IsOptional()
  @IsString()
  assignedMemberId?: string | 'me' | 'unassigned';

  @IsOptional()
  @IsString()
  status?: string; // ConversationStatus (string to avoid tight coupling)

  @IsOptional()
  @IsString()
  priority?: string; // ConversationPriority

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 20;

  @IsOptional()
  @IsEnum(InboxOrderBy)
  orderBy: InboxOrderBy = InboxOrderBy.lastMessageAt;
}




export class SendAttachmentDto {
  @IsString()
  type!: string; // AttachmentType
  @IsString()
  url!: string;
  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class SendMessageDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SendAttachmentDto)
  attachments?: SendAttachmentDto[];
}


export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  priority?: string;

  @IsOptional()
  @IsString()
  assignedMemberId?: string | null;

  @IsOptional()
  @IsDateString()
  snoozedUntil?: string | null;

  @IsOptional()
  @IsDateString()
  archivedAt?: string | null;
}
