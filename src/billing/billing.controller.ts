import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Ip, Post, Query, Req, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PlanDto } from './dto/plan-response.dto';
import { Public } from '@/common/decorators/public.decorator';
import { BypassSubscription } from '@/common/decorators/bypass-subscription.decorator';
import { ContextGuard } from '@/common/guards/context.guard';
import { PermissionResource, PermissionAction } from '@generated/enums';
import { OrgAuth } from '@/common/decorators/auth.decorator';

@ApiTags('Billing')
@Controller('billing')
@BypassSubscription() 
export class BillingController {
  constructor(private readonly billingService: BillingService) {}


  @Get('plans')
  @Public()
  @ApiOperation({
    summary: 'Get available subscription plans',
    description: 'Returns all active billing plans ordered by price (NGN).',
  })
  @ApiResponse({
    status: 200,
    description: 'List of available plans',
    type: [PlanDto],
  })
  async getPlans(@Ip() ip: string) {
    return this.billingService.getAvailablePlans(ip);
  }

  @Get('verify')
  @Public()
  @ApiOperation({
    summary: 'Verify payment status',
    description: 'Called by Frontend/Gateway callback to check transaction status.',
  })
  async verifyPayment(@Query('reference') reference: string) {
    return this.billingService.verifyPayment(reference);
  }

  // ===========================================================================
  // AUTHENTICATED ROUTES 
  // ===========================================================================

  @Get('subscription')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Get current subscription details',
    description: 'Returns the active plan, status, and renewal dates.',
  })
  async getSubscription(@Req() req: any) {
    // ContextGuard ensures req.user.organizationId is populated
    return this.billingService.getSubscription(req.user.organizationId);
  }

  @Post('checkout')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initialize new payment or upgrade',
    description: 'Generates a payment link (Paystack) based on User IP currency.',
  })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({
    status: 201,
    description: 'Payment initialized successfully',
    schema: { example: { paymentUrl: 'https://checkout...', reference: '...' } }
  })
  async initializePayment(
    @Req() req: any,
    @Body() body: CreatePaymentDto,
    @Ip() ip: string 
  ) {
    return this.billingService.initializePayment(
      req.user.organizationId,
      body.planId,
      req.user,
    );
  }

  // ===========================================================================
  // PROTECTED ROUTES (Admins/Owners Only)
  // ===========================================================================

  @Delete('subscription')
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @UseGuards(ContextGuard)
  @OrgAuth({ resource: PermissionResource.BILLING, action: PermissionAction.MANAGE })
  @ApiOperation({
    summary: 'Cancel auto-renewal',
    description: 'Downgrades to free tier at the end of the current period.',
  })
  async cancelSubscription(@Req() req: any) {
    return this.billingService.cancelSubscription(req.user.organizationId);
  }
}