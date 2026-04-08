import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  BadRequestException,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiParam,
  ApiQuery,
  ApiBody,
} from '@nestjs/swagger';
import {
  CreatePlanDto,
  UpdatePlanDto,
  ManualOverrideDto,
  CreateInvoiceDto,
  GetPaymentsQueryDto,
  OverrideType,
  MetricsResponseDto,
  PlansListResponseDto,
  SinglePlanResponseDto,
  PaginatedPaymentsResponseDto,
  InvoiceResponseDto,
  OverrideResponseDto,
  ErrorResponseDto,
} from './admin-billing.dto';
import { AdminBillingService } from './admin-biilings.service';
import { AdminJwtGuard } from '../guards/admin-jwt.guard';

@ApiTags('Admin — Billing')
@ApiBearerAuth()
@UseGuards(AdminJwtGuard) // ← plug in your admin guard here
@Controller('admin/billing')
export class AdminBillingController {
  constructor(private readonly billingService: AdminBillingService) {}

  // ─── METRICS ───────────────────────────────────────────────────────────────

  @Get('metrics')
  @ApiOperation({
    summary: 'Get billing dashboard metrics',
    description:
      'Returns MRR, ARR (in NGN), churn rate, and flagged transaction count.',
  })
  @ApiResponse({ status: 200, type: MetricsResponseDto })
  async getMetrics() {
    const data = await this.billingService.getBillingMetrics();
    return { success: true, data };
  }

  // ─── PAYMENT HISTORY ───────────────────────────────────────────────────────

  @Get('payments')
  @ApiOperation({ summary: 'List payment history (paginated)' })
  @ApiResponse({ status: 200, type: PaginatedPaymentsResponseDto })
  async getPayments(@Query() query: GetPaymentsQueryDto) {
    const result = await this.billingService.getPaymentHistory({
      search: query.search,
      page: query.page,
      limit: query.limit,
    });
    return { success: true, ...result };
  }

  // ─── INVOICES ──────────────────────────────────────────────────────────────

  @Post('invoices')
  @ApiOperation({
    summary: 'Create a manual invoice',
    description: 'Records a manual transaction with provider set to MANUAL.',
  })
  @ApiBody({ type: CreateInvoiceDto })
  @ApiResponse({ status: 201, type: InvoiceResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  async createInvoice(@Body() body: CreateInvoiceDto) {
    const data = await this.billingService.createInvoice(body);
    return { success: true, data };
  }

  // ─── PLANS ─────────────────────────────────────────────────────────────────

  @Post('plans')
  @ApiOperation({
    summary: 'Create a new plan tier',
    description: 'Adds a new subscription tier. name and tier are permanent after creation.',
  })
  @ApiBody({ type: CreatePlanDto })
  @ApiResponse({ status: 201, type: SinglePlanResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  async createPlan(@Body() body: CreatePlanDto) {
    const data = await this.billingService.createPlan(body as any);
    return { success: true, data };
  }

  @Patch('plans/:planId')
  @ApiOperation({
    summary: 'Edit plan configuration',
    description: 'Editable fields: Pricing, Limits, Features, Platforms, isActive. Sending `name` or `tier` returns 400.',
  })
  @ApiParam({ name: 'planId', example: 'clxyz123abc' })
  @ApiBody({ type: UpdatePlanDto })
  async updatePlan(
    @Param('planId') planId: string,
    @Body() body: UpdatePlanDto & { name?: unknown; tier?: unknown },
  ) {
    // Guard: name and tier are immutable
    if ('name' in body || 'tier' in body) {
      throw new BadRequestException('Plan name and tier cannot be changed after creation');
    }

    if (Object.keys(body).length === 0) {
      throw new BadRequestException('Provide at least one editable field');
    }

    // Since the DTO properties now exactly match UpdatePlanInput, we can just pass the body.
    const data = await this.billingService.updatePlan(planId, body as any);

    return { success: true, data };
  }

  @Get('plans/:planId')
  @ApiOperation({ summary: 'Get a single plan by ID' })
  @ApiParam({ name: 'planId', example: 'clxyz123abc' })
  @ApiResponse({ status: 200, type: SinglePlanResponseDto })
  @ApiResponse({ status: 404, description: 'Plan not found.' })
  async getPlan(@Param('planId') planId: string) {
    const data = await this.billingService.getPlanById(planId);
    return { success: true, data };
  }

  // ─── MANUAL OVERRIDES ──────────────────────────────────────────────────────

  @Post('overrides')
  @ApiOperation({
    summary: 'Apply a manual subscription override',
    description:
      '`extend_trial` adds 7 days from the later of now or currentPeriodEnd. ' +
      '`custom_end_date` sets an explicit future date (requires `customEndDate`). ' +
      'Both set status=active, isActive=true, cancelAtPeriodEnd=false.',
  })
  @ApiBody({ type: ManualOverrideDto })
  @ApiResponse({ status: 200, type: OverrideResponseDto })
  @ApiResponse({ status: 400, type: ErrorResponseDto })
  @ApiResponse({
    status: 404,
    description: 'Organization or subscription not found.',
  })
  async applyOverride(@Body() body: ManualOverrideDto) {
    const data = await this.billingService.applyManualOverride({
      organizationId: body.organizationId,
      overrideType: body.overrideType as OverrideType,
      customEndDate: body.customEndDate
        ? new Date(body.customEndDate)
        : undefined,
    });

    const message =
      body.overrideType === OverrideType.EXTEND_TRIAL
        ? 'Subscription extended by 1 week'
        : `Subscription extended to ${new Date(body.customEndDate!).toDateString()}`;

    return { success: true, message, data };
  }
}
