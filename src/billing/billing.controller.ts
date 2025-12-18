import { Body, Controller, Delete, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PlanDto } from './dto/plan-response.dto';
import { Public } from '@/common/decorators/public.decorator';

@ApiTags('Billing')
@ApiBearerAuth()
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}


  @Get('plans')
  @Public()
  @ApiOperation({
    summary: 'Get available subscription plans',
    description: 'Returns all active billing plans ordered by price.',
  })
  @ApiResponse({
    status: 200,
    description: 'List of available plans',
    type: [PlanDto],
  })
  async getPlans() {
    return this.billingService.getAvailablePlans();
  }

  @Get('subscription')
  @ApiOperation({
    summary: 'Get current organization subscription',
    description: 'Returns the active subscription and plan details.',
  })
  @ApiResponse({
    status: 200,
    description: 'Current subscription details',
  })
  @ApiResponse({
    status: 404,
    description: 'No subscription found',
  })
  async getSubscription(@Req() req: any) {
    const organizationId = req.user.organizationId;
    return this.billingService.getSubscription(organizationId);
  }


  @Post('checkout')
  @Public()
  @ApiOperation({
    summary: 'Initialize subscription payment',
    description:
      'Creates a Flutterwave checkout session and returns a payment URL.',
  })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({
    status: 201,
    description: 'Payment initialized',
    schema: {
      example: {
        paymentUrl: 'https://checkout.flutterwave.com/...',
        txRef: 'rooli_org123_171500000',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid plan or billing email missing',
  })
  async initializePayment(
    @Req() req: any,
    body: CreatePaymentDto,
  ) {
    const organizationId = req.user.organizationId;
    const user = req.user;

    return this.billingService.initializePayment(
      organizationId,
      body.planId,
    );
  }


  @Delete('subscription')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Cancel current subscription',
    description:
      'Cancels auto-renewal. Access remains until the current period ends.',
  })
  @ApiResponse({
    status: 200,
    description: 'Subscription cancelled successfully',
  })
  @ApiResponse({
    status: 400,
    description: 'No active subscription to cancel',
  })
  async cancelSubscription(@Req() req: any) {
    const organizationId = req.user.organizationId;
    return this.billingService.cancelSubscription(organizationId);
  }
}
