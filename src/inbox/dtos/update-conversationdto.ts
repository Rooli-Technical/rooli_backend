import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class UpdateConversationDto {
  @ApiPropertyOptional({ enum: ['OPEN', 'CLOSED', 'SNOOZED'] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional({ enum: ['LOW', 'NORMAL', 'HIGH', 'URGENT'] })
   @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({ description: 'ID of the agent to assign this to' })
   @IsOptional()
  @IsString()
  assignedMemberId?: string | null;

  @ApiPropertyOptional({ description: 'Move to archive', type: Boolean })
   @IsOptional()
  @IsString()
  archived?: boolean;

  @ApiPropertyOptional({ description: 'Snooze until specific date' })
   @IsOptional()
  @IsString()
  snoozedUntil?: Date | null;
}
