import { Platform } from "@generated/enums";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsArray, IsOptional, IsInt, Min, Max } from "class-validator";

export class GenerateVariantsDto {
  @ApiProperty({ example: 'Post about why consistency beats hype in marketing' })
  @IsString()
  prompt: string;

  @ApiProperty({ isArray: true, example: ['LINKEDIN','X'] })
  @IsArray()
  platforms: Platform[];

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  @Min(2)
  @Max(6)
  variantsPerPlatform?: number;

  @ApiPropertyOptional({ example: 'ckit_123' })
  @IsOptional()
  @IsString()
  brandKitId?: string;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  saveAsDraftPost?: boolean;
}
