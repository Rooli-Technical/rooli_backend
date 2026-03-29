import {
  IsString,
  IsNumber,
  IsOptional,
  IsEnum,
  IsDateString,
  IsPositive,
  IsInt,
  IsBoolean,
  Min,
  IsNotEmpty,
  IsUrl,
  ValidateIf,
} from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";

// ─── ENUMS (mirror Prisma enums) ─────────────────────────────────────────────

export enum PlanTierEnum {
  CREATOR = "CREATOR",
  PRO = "PRO",
  ROCKET = "ROCKET",
  ENTERPRISE = "ENTERPRISE",
}

export enum BillingIntervalEnum {
  MONTHLY = "MONTHLY",
  YEARLY = "YEARLY",
}

export enum OverrideType {
  EXTEND_TRIAL = "extend_trial",
  CUSTOM_END_DATE = "custom_end_date",
}

export enum TransactionStatus {
  SUCCESSFUL = "successful",
  FAILED = "failed",
  ABANDONED = "abandoned",
}

export enum SubscriptionStatus {
  ACTIVE = "active",
  PAST_DUE = "past_due",
  CANCELED = "canceled",
  INCOMPLETE = "incomplete",
}

// ─── PLAN DTOs ───────────────────────────────────────────────────────────────

export class CreatePlanDto {
  @ApiProperty({
    example: "Rocket",
    description:
      "Unique plan name. Permanent — cannot be changed after creation.",
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({
    example: "Best for growing agencies",
    description: "Optional plan description.",
  })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({
    enum: PlanTierEnum,
    example: PlanTierEnum.ROCKET,
    description: "Plan tier. Permanent — cannot be changed after creation.",
  })
  @IsEnum(PlanTierEnum)
  tier: PlanTierEnum;

  @ApiProperty({
    enum: BillingIntervalEnum,
    example: BillingIntervalEnum.MONTHLY,
  })
  @IsEnum(BillingIntervalEnum)
  interval: BillingIntervalEnum;

  @ApiProperty({
    example: 29000,
    description: "Monthly price in NGN (kobo or full units — match your Paystack setup).",
  })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceNgn: number;

  @ApiProperty({
    example: 29,
    description: "Monthly price in USD.",
  })
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceUsd: number;

  @ApiPropertyOptional({ example: 5, default: 1 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxWorkspaces?: number;

  @ApiPropertyOptional({ example: 4, default: 3 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxSocialProfilesPerWorkspace?: number;

  @ApiPropertyOptional({
    example: -1,
    default: 1,
    description: "Max team members. Use -1 for unlimited.",
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  maxTeamMembers?: number;

  @ApiPropertyOptional({ example: 500, default: 100 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  monthlyAiCredits?: number;

  @ApiPropertyOptional({ example: "PLN_abc123ngn" })
  @IsOptional()
  @IsString()
  paystackPlanCodeNgn?: string;

  @ApiPropertyOptional({ example: "PLN_abc123usd" })
  @IsOptional()
  @IsString()
  paystackPlanCodeUsd?: string;
}

export class UpdatePlanDto {
  @ApiPropertyOptional({
    example: 35000,
    description:
      "New NGN price. name and tier are NOT accepted — sending them returns 400.",
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceNgn?: number;

  @ApiPropertyOptional({ example: 35 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Type(() => Number)
  priceUsd?: number;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxWorkspaces?: number;

  @ApiPropertyOptional({ example: 6 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  maxSocialProfilesPerWorkspace?: number;

  @ApiPropertyOptional({
    example: -1,
    description: "-1 = unlimited.",
  })
  @IsOptional()
  @IsInt()
  @Type(() => Number)
  maxTeamMembers?: number;

  @ApiPropertyOptional({ example: 1000 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  @Type(() => Number)
  monthlyAiCredits?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ─── MANUAL OVERRIDE DTO ─────────────────────────────────────────────────────

export class ManualOverrideDto {
  @ApiProperty({
    example: "clxyz123abc",
    description: "ID of the organization whose subscription will be overridden.",
  })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({
    enum: OverrideType,
    example: OverrideType.EXTEND_TRIAL,
    description:
      "`extend_trial` adds 7 days from the later of now or the current period end. " +
      "`custom_end_date` requires `customEndDate`.",
  })
  @IsEnum(OverrideType)
  overrideType: OverrideType;

  @ApiPropertyOptional({
    example: "2025-06-01",
    description:
      "Required when overrideType is `custom_end_date`. ISO 8601 date. Must be future.",
  })
  @ValidateIf((o) => o.overrideType === OverrideType.CUSTOM_END_DATE)
  @IsNotEmpty({ message: "customEndDate is required for custom_end_date override" })
  @IsDateString()
  customEndDate?: string;
}

// ─── INVOICE DTO ──────────────────────────────────────────────────────────────

export class CreateInvoiceDto {
  @ApiProperty({ example: "clxyz123abc" })
  @IsString()
  @IsNotEmpty()
  organizationId: string;

  @ApiProperty({
    example: 2499,
    description: "Amount in base currency units.",
  })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  amount: number;

  @ApiPropertyOptional({ example: "NGN", default: "NGN" })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiProperty({ example: "INV-2024-0001" })
  @IsString()
  @IsNotEmpty()
  txRef: string;

  @ApiPropertyOptional({
    example: "https://storage.example.com/invoices/INV-2024-0001.pdf",
  })
  @IsOptional()
  @IsUrl()
  invoiceUrl?: string;
}

// ─── QUERY DTO ────────────────────────────────────────────────────────────────

export class GetPaymentsQueryDto {
  @ApiPropertyOptional({
    example: "Tech Solutions",
    description: "Search by organization name or txRef.",
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number;
}

// ─── RESPONSE DTOs ────────────────────────────────────────────────────────────

export class PlanResponseDto {
  @ApiProperty({ example: "clxyz123abc" })
  id: string;

  @ApiProperty({ example: "Rocket" })
  name: string;

  @ApiProperty({ enum: PlanTierEnum, example: PlanTierEnum.ROCKET })
  tier: PlanTierEnum;

  @ApiProperty({ enum: BillingIntervalEnum, example: BillingIntervalEnum.MONTHLY })
  interval: BillingIntervalEnum;

  @ApiProperty({ example: "29000.00", description: "NGN price as Decimal string." })
  priceNgn: string;

  @ApiProperty({ example: "29.00", description: "USD price as Decimal string." })
  priceUsd: string;

  @ApiProperty({ example: 5 })
  maxWorkspaces: number;

  @ApiProperty({ example: 4 })
  maxSocialProfilesPerWorkspace: number;

  @ApiProperty({ example: -1, description: "-1 = unlimited." })
  maxTeamMembers: number;

  @ApiProperty({ example: 500 })
  monthlyAiCredits: number;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({
    example: { canRemoveBranding: true, hasAdvancedAnalytics: true },
  })
  features: Record<string, boolean>;

  @ApiProperty({ example: "PLN_abc123ngn", nullable: true })
  paystackPlanCodeNgn: string | null;

  @ApiProperty({ example: "PLN_abc123usd", nullable: true })
  paystackPlanCodeUsd: string | null;

  @ApiProperty({ example: "2024-03-18T09:15:00.000Z" })
  createdAt: string;

  @ApiProperty({ example: "2024-03-18T09:15:00.000Z" })
  updatedAt: string;
}

export class BillingMetricsResponseDto {
  @ApiProperty({ example: 124500, description: "MRR in NGN." })
  mrr: number;

  @ApiProperty({ example: 1494000, description: "ARR in NGN (MRR × 12)." })
  arr: number;

  @ApiProperty({ example: 2.4, description: "Churn rate % this month." })
  churnRate: number;

  @ApiProperty({
    example: 7,
    description: "Failed/abandoned transactions needing review.",
  })
  flagged: number;
}

export class OrganizationSummaryDto {
  @ApiProperty({ example: "clorg456def" })
  id: string;

  @ApiProperty({ example: "Tech Solutions Inc." })
  name: string;

  @ApiProperty({ example: "tech-solutions" })
  slug: string;
}

export class TransactionResponseDto {
  @ApiProperty({ example: "cltxn789ghi" })
  id: string;

  @ApiProperty({ example: "clorg456def" })
  organizationId: string;

  @ApiProperty({ example: "2499.00" })
  amount: string;

  @ApiProperty({ example: "NGN" })
  currency: string;

  @ApiProperty({ enum: TransactionStatus, example: TransactionStatus.SUCCESSFUL })
  status: TransactionStatus;

  @ApiProperty({ example: "TXN-20240320-001" })
  txRef: string;

  @ApiProperty({ example: "PAYSTACK" })
  provider: string;

  @ApiProperty({ example: "re_abc123xyz" })
  providerTxId: string;

  @ApiProperty({ example: "Rocket", description: "Plan name from active subscription." })
  planName: string;

  @ApiProperty({ enum: PlanTierEnum, example: PlanTierEnum.ROCKET })
  planTier: PlanTierEnum;

  @ApiProperty({ example: "2024-03-20T14:30:00.000Z" })
  paymentDate: string;

  @ApiProperty({ type: () => OrganizationSummaryDto })
  organization: OrganizationSummaryDto;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 5 })
  pages: number;
}

export class SubscriptionResponseDto {
  @ApiProperty({ example: "clsub789ghi" })
  id: string;

  @ApiProperty({ example: "clorg456def" })
  organizationId: string;

  @ApiProperty({ enum: SubscriptionStatus, example: SubscriptionStatus.ACTIVE })
  status: SubscriptionStatus;

  @ApiProperty({ example: true })
  isActive: boolean;

  @ApiProperty({ example: "2024-03-01T00:00:00.000Z" })
  currentPeriodStart: string;

  @ApiProperty({ example: "2024-04-01T00:00:00.000Z" })
  currentPeriodEnd: string;

  @ApiProperty({ example: false })
  cancelAtPeriodEnd: boolean;

  @ApiProperty({ type: () => PlanResponseDto })
  plan: PlanResponseDto;

  @ApiProperty({ type: () => OrganizationSummaryDto })
  organization: OrganizationSummaryDto;
}

// ─── ENVELOPE RESPONSES ───────────────────────────────────────────────────────

export class MetricsResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ type: () => BillingMetricsResponseDto })
  data: BillingMetricsResponseDto;
}

export class PlansListResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ type: [PlanResponseDto] })
  data: PlanResponseDto[];
}

export class SinglePlanResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ type: () => PlanResponseDto })
  data: PlanResponseDto;
}

export class PaginatedPaymentsResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ type: [TransactionResponseDto] })
  data: TransactionResponseDto[];
  @ApiProperty({ type: () => PaginationMetaDto })
  meta: PaginationMetaDto;
}

export class InvoiceResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ type: () => TransactionResponseDto })
  data: TransactionResponseDto;
}

export class OverrideResponseDto {
  @ApiProperty({ example: true })
  success: boolean;
  @ApiProperty({ example: "Subscription extended by 1 week" })
  message: string;
  @ApiProperty({ type: () => SubscriptionResponseDto })
  data: SubscriptionResponseDto;
}

export class ErrorResponseDto {
  @ApiProperty({ example: false })
  success: boolean;
  @ApiProperty({ example: "Plan name cannot be changed after creation" })
  error: string;
}