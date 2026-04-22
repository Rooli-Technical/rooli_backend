import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { BillingService } from './billing.service';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { PlanDto } from './dto/plan-response.dto';
import { Public } from '@/common/decorators/public.decorator';
import { BypassSubscription } from '@/common/decorators/bypass-subscription.decorator';
import { Throttle } from '@nestjs/throttler';
import { PermissionsGuard } from '@/common/guards/permission.guard';
import { ContextGuard } from '@/common/guards/context.guard';
import {
  PermissionResource,
  PermissionAction,
  PermissionScope,
} from '@/common/constants/rbac';
import { RequirePermission } from '@/common/decorators/require-permission.decorator';
import { CurrentUser } from '@/common/decorators/current-user.decorator';
import { ChangePlanDto } from './dto/change-plan.dto';

@ApiTags('Billing')
@BypassSubscription()
@UseGuards(ContextGuard, PermissionsGuard)
@Controller('organizations/:orgId/billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  // ===========================================================================
  // AUTHENTICATED ROUTES
  // ===========================================================================

  @Get('subscription')
  @RequirePermission(PermissionResource.ORG_BILLING, PermissionAction.READ)
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
  @RequirePermission(PermissionResource.ORG_BILLING, PermissionAction.MANAGE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Initialize new payment or upgrade',
    description:
      'Generates a payment link (Paystack) based on User IP currency.',
  })
  @ApiBody({ type: CreatePaymentDto })
  @ApiResponse({
    status: 201,
    description: 'Payment initialized successfully',
    schema: {
      example: { paymentUrl: 'https://checkout...', reference: '...' },
    },
  })
  async initializePayment(
    @Req() req: any,
    @Body() body: CreatePaymentDto,
    @Ip() ip: string,
  ) {
    return this.billingService.initializePayment(
      req.user.organizationId,
      body.planId,
      body.interval,
      req.user,
    );
  }

  // ===========================================================================
  // PROTECTED ROUTES (Admins/Owners Only)
  // ===========================================================================

  @Delete('subscription')
  @RequirePermission(PermissionResource.ORG_BILLING, PermissionAction.MANAGE)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel auto-renewal',
    description: 'Downgrades to free tier at the end of the current period.',
  })
  async cancelSubscription(@Req() req: any) {
    return this.billingService.cancelSubscription(req.user.organizationId);
  }

  @Post('change-plan')
  @ApiBearerAuth()
  @RequirePermission(PermissionResource.ORG_BILLING, PermissionAction.MANAGE)
  @ApiOperation({
    summary: 'Change or schedule a plan switch',
    description:
      'If the user is on a trial, this returns a payment initialization URL for instant checkout. ' +
      'If the user is on a paid plan, it verifies limits (users, profiles, workspaces) and schedules the change for the next billing cycle.',
  })
  @ApiResponse({
    status: 200,
    description: 'Plan successfully scheduled or payment initialized.',
    schema: {
      oneOf: [
        {
          properties: {
            status: { type: 'string', example: 'scheduled' },
            message: {
              type: 'string',
              example:
                'Your plan will automatically change to Rocket (ANNUAL) at the end of your current billing cycle.',
            },
          },
        },
        {
          properties: {
            authorization_url: {
              type: 'string',
              example: 'https://checkout.paystack.com/xyz',
            },
            access_code: { type: 'string', example: 'PLN_123' },
            reference: { type: 'string', example: 'ref_001' },
          },
        },
      ],
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Limit check failed (too many members/profiles) or no subscription found.',
  })
  @ApiResponse({ status: 404, description: 'Target plan not found.' })
  async changePlan(
    @Param('orgId') orgId: string,
    @Body() body: ChangePlanDto,
    @CurrentUser() user: any, // Your custom decorator to get the current user
  ) {
    return this.billingService.changePlan(
      orgId,
      body.newPlanId,
      body.interval,
      user,
    );
  }

  @Post('workspaces/extra')
  @ApiBearerAuth()
  @RequirePermission(PermissionResource.SUBSCRIPTION, PermissionAction.MANAGE) 
  @ApiOperation({ 
    summary: 'Purchase Extra Workspace', 
    description: 'Instantly charges the saved payment method for an additional workspace. Cost is automatically prorated based on the days left in the current billing cycle. (Available on Business and Rocket plans only).' 
  })
  @ApiParam({ 
    name: 'orgId', 
    description: 'The unique ID of the organization' 
  })
  @ApiResponse({ 
    status: 201, 
    description: 'Workspace purchased successfully',
    schema: {
      example: {
        message: 'Additional workspace purchased successfully.',
        amountCharged: 15,
        currency: 'USD',
        newTotalWorkspacesAllowed: 4
      }
    }
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Payment failed, no saved card found, or no active subscription.' 
  })
  @ApiResponse({ 
    status: 403, 
    description: 'Organization is not on the Business or Rocket plan.' 
  })
  async purchaseExtraWorkspace(
    @Param('orgId') orgId: string,
  ) {
    return this.billingService.purchaseExtraWorkspace(orgId);
  }

  @Delete('workspaces/extra')
  @ApiBearerAuth()
  @RequirePermission(PermissionResource.SUBSCRIPTION, PermissionAction.MANAGE) 
  @ApiOperation({ 
    summary: 'Cancel Extra Workspace Add-on', 
    description: 'Cancels the auto-renewal of an extra workspace add-on. The organization will stop being charged for extra workspaces starting from the next billing cycle. This action is only allowed if the organization has enough workspaces remaining within their base plan limit.' 
  })
  @ApiParam({ 
    name: 'orgId', 
    description: 'The unique ID of the organization' 
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Workspace add-on successfully canceled.',
    schema: {
      example: {
        message: 'Workspace add-on successfully canceled. You will not be billed for it on your next cycle.',
        newTotalWorkspacesAllowed: 3,
        extraWorkspacesRemaining: 0
      }
    }
  })
  @ApiResponse({ 
    status: 400, 
    description: 'No active subscription found or no extra workspaces purchased.' 
  })
  @ApiResponse({ 
    status: 403, 
    description: 'Usage limit exceeded. Please delete active workspaces before canceling the add-on.' 
  })
  async cancelExtraWorkspace(
    @Param('orgId') orgId: string,
  ) {
    return this.billingService.cancelExtraWorkspace(orgId);
  }

  @Patch('subscription/update-card')
  @ApiBearerAuth()
  @RequirePermission(PermissionResource.SUBSCRIPTION, PermissionAction.MANAGE) 
  @ApiOperation({ 
    summary: 'Update Payment Method', 
    description: 'Replaces the organization\'s current payment method with a new one. This is used to update an expired or replaced card.' 
  })
  @ApiParam({ 
    name: 'orgId', 
    description: 'The unique ID of the organization' 
  })
  @ApiResponse({ 
    status: 200, 
    description: 'Payment method updated successfully',
    schema: {
      example: {
        message: 'Payment method updated successfully.',
        card: {
          authorization_code: 'AUTH_CODE',
          last4: '4444',
          exp_month: 12,
          exp_year: 2025,
          card_type: 'visa'
        }
      }
    }
  })
  @ApiResponse({ 
    status: 400, 
    description: 'Invalid card details or payment method update failed.' 
  })
  @ApiResponse({ 
    status: 404, 
    description: 'No active subscription found.' 
  })
  async updateCard(
    @Param('orgId') orgId: string,
    @Req() req: any,
  ) {
    return this.billingService.replaceCard(orgId, req.user);
  }

  @Post('workspaces/:workspaceId/unlock')
  @ApiBearerAuth()
  @RequirePermission(PermissionResource.SUBSCRIPTION, PermissionAction.MANAGE)
  @ApiOperation({
    summary: 'Unlock a locked workspace',
    description:
      'Unlocks a workspace that was locked due to a plan downgrade or cycle reset. ' +
      'Only succeeds if the organization has available workspace slots (base plan + purchased add-ons).',
  })
  @ApiParam({ name: 'orgId', description: 'The unique ID of the organization' })
  @ApiParam({ name: 'workspaceId', description: 'The unique ID of the workspace to unlock' })
  @ApiResponse({
    status: 201,
    description: 'Workspace successfully unlocked.',
    schema: {
      example: { message: 'Workspace successfully unlocked.' },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'No active subscription found.',
  })
  @ApiResponse({
    status: 403,
    description: 'Active workspace limit reached. Purchase an extra workspace add-on first.',
  })
  async unlockWorkspace(
    @Param('orgId') orgId: string,
    @Param('workspaceId') workspaceId: string,
  ) {
    return this.billingService.unlockWorkspace(orgId, workspaceId);
  }

  @Post('simulate-expiration')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Simulate subscription expiration',
    description: 'Simulates subscription expiration for testing purposes.',
  })
  async simulateExpiration(@Param('orgId') orgId: string) {
    return this.billingService.simulateExpiration(orgId);
  }
}
