import { Controller, Get, Headers, Ip, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BillingService } from './billing.service';
import { PlanDto } from './dto/plan-response.dto';
import { Public } from '@/common/decorators/public.decorator';

@ApiTags('Billing')
@Public()
@Controller('billing')
export class BillingPublicController {
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
  async getPlans(
    @Ip() ip: string,
    @Headers('x-timezone') clientTimezone?: string,
  ) {
    return this.billingService.getAvailablePlans(ip, clientTimezone);
  }

  @Get('verify')
  @Public()
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @ApiOperation({
    summary: 'Verify payment status',
    description:
      'Called by Frontend/Gateway callback to check transaction status.',
  })
  async verifyPayment(@Query('reference') reference: string) {
    return this.billingService.verifyPayment(reference);
  }
}
