import { IsEnum, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';
import { Platform, PostStatus } from '@generated/enums';
import { Expose, Type } from 'class-transformer';

export class PaginationDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;
}


export class QueryRateLimitDto extends PaginationDto {
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;

  @IsOptional()
  @IsString()
  status?: string; // "allowed" | "blocked"

  @IsOptional()
  @IsString()
  socialAccountId?: string;
}

export class CreateRateLimitLogDto {
  @IsEnum(Platform)
  platform: Platform;

  @IsString()
  socialAccountId: string;

  @IsString()
  requestType: string;

  @IsString()
  windowStart: string;

  @IsString()
  windowEnd: string;

  @IsString()
  status: string; // "allowed" | "blocked"
}

export class QuerySocialHealthDto extends PaginationDto {
  @IsOptional()
  @IsEnum(Platform)
  platform?: Platform;
}


export class QueryPostDto {
  @IsOptional()
  @Type(() => Number)  // ✅ transforms string to number
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)  // ✅ transforms string to number
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

export class FailedDestinationDto {
  @Expose()
  platform: string;

  @Expose()
  status: string;

  @Expose()
  errorMessage?: string;

  @Expose()
  publishedAt?: Date;
}

export class FailedPostJobDto {
  @Expose()
  id: string;

  @Expose()
  content?: string;

  @Expose()
  status: string;

  @Expose()
  errorMessage?: string;

  @Expose()
  retryCount: number;

  @Expose()
  maxRetries: number;

  @Expose()
  isRetryable: boolean;

  @Expose()
  createdAt: Date;

  @Expose()
  @Type(() => FailedDestinationDto)
  destinations: FailedDestinationDto[];
}