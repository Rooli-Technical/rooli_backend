// Add these to your DTOs file, or at the top of the controller:
import { IsString, IsNumber, IsOptional, ValidateNested, IsArray } from 'class-validator';
import { Type } from 'class-transformer';

export class CloudinaryUploadPayloadDto {
  @IsString() originalName: string;
  @IsString() mimeType: string;
  @IsNumber() size: number; // Bytes from Cloudinary
  @IsString() secure_url: string;
  @IsString() public_id: string;
  @IsString() resource_type: string;
  @IsOptional() @IsNumber() width?: number;
  @IsOptional() @IsNumber() height?: number;
  @IsOptional() @IsNumber() duration?: number;
}

export class SaveMetadataDto {
  @ValidateNested()
  @Type(() => CloudinaryUploadPayloadDto)
  file: CloudinaryUploadPayloadDto;

  @IsOptional()
  @IsString()
  folderId?: string;
}

export class SaveMultipleMetadataDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CloudinaryUploadPayloadDto)
  files: CloudinaryUploadPayloadDto[];

  @IsOptional()
  @IsString()
  folderId?: string;
}
