import { TicketCategory, TicketPriority } from '@generated/enums';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsBoolean, IsOptional, IsArray, IsEnum } from 'class-validator';


export class CreateTicketDto {
  @ApiProperty({ example: 'Cannot access dashboard' })
  @IsString()
  @IsNotEmpty()
  title: string;

  @ApiProperty({ example: 'The screen goes white when I click the "Home" button.' })
  @IsString()
  @IsNotEmpty()
  description: string;

  @ApiProperty({ enum: TicketCategory, example: TicketCategory.BUG })
  @IsEnum(TicketCategory)
  category: TicketCategory;

  @ApiPropertyOptional({ enum: TicketPriority, default: TicketPriority.MEDIUM })
  @IsOptional()
  @IsEnum(TicketPriority)
  priority?: TicketPriority;

  @ApiPropertyOptional({ type: [String], description: 'Array of uploaded file IDs' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaFileIds?: string[];
}

export class AddCommentDto {
  @ApiProperty({ example: 'We are looking into this right now.' })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({ description: 'True if the comment is from a support agent' })
  @IsBoolean()
  isFromSupport: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  mediaFileIds?: string[];
}