import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { 
  IsString, 
  IsNotEmpty, 
  IsHexColor, 
  IsOptional, 
  MaxLength,
  Matches
} from 'class-validator';

export class CreateLabelDto {
  @ApiProperty({ example: 'Product Launch', description: 'The visible label name' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  // Optional: Prevent weird characters in labels if you want to use them as tags
   @Matches(/^[a-zA-Z0-9\s-_]+$/, { message: 'Label name contains invalid characters' })
  name: string;

  @ApiPropertyOptional({ example: '#00AAFF', description: 'Color badge for the UI' })
  @IsOptional()
  @IsHexColor()
  color?: string;
}