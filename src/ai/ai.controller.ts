import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import { AiService } from './service/ai.service';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiForbiddenResponse, ApiParam } from '@nestjs/swagger';
import { BulkGenerateDto } from './dto/bulk-generate.dto';
import { GenerateCaptionDto } from './dto/generate-caption.dto';
import { GenerateVariantsDto } from './dto/generate-variant.dto';
import { RepurposeContentDto } from './dto/repurpose-content.dto';
import { AiQuotaService } from './service/quota.service';

@ApiTags('AI Module')
@ApiBearerAuth()
@Controller('workspaces/:workspaceId/ai')
export class AiController {
  constructor(private readonly aiService: AiService, private readonly quotaService: AiQuotaService) {}

  @Post('caption')
  @ApiOperation({ 
    summary: 'Generate a single caption',
    description: 'Generates a social media post based on a topic and Brand Kit.' 
  })
  @ApiParam({ 
    name: 'workspaceId', 
    description: 'The unique ID of the workspace',
    example: 'cuid-123-456' 
  })
  @ApiOkResponse({ description: 'Caption generated successfully.' })
  async generateCaption(@Req() req, @Body() dto: GenerateCaptionDto, @Param('workspaceId') workspaceId: string) {
    return this.aiService.generateCaption(workspaceId, req.user.userId, dto);
  }

  @Post('variants')
  @ApiOperation({ 
    summary: 'Generate multi-platform variants',
    description: 'Creates tailored versions of a post for LinkedIn, X, FB, etc.' 
  })
  @ApiForbiddenResponse({ description: 'Platform limit exceeded for your plan.' })
  async generateVariants(@Req() req, @Body() dto: GenerateVariantsDto, @Param('workspaceId') workspaceId: string) {
    return this.aiService.generatePlatformVariants(workspaceId, req.user.userId, dto);
  }

  @Post('repurpose')
  @ApiOperation({ 
    summary: 'Repurpose URL or Text (Business+)',
    description: 'Scrapes a URL or takes text and transforms it into a new post format.' 
  })
  async repurpose(@Req() req, @Body() dto: RepurposeContentDto, @Param('workspaceId') workspaceId: string) {
    return this.aiService.repurposeContent(workspaceId, req.user.userId, dto);
  }

  @Post('bulk')
  @ApiOperation({ 
    summary: 'Bulk Calendar Generation (Rocket only)',
    description: 'Generates a batch of posts for a specific topic and date range.' 
  })
  async generateBulk(@Req() req, @Body() dto: BulkGenerateDto, @Param('workspaceId') workspaceId: string) {
    return this.aiService.generateBulk(workspaceId, req.user.userId, dto);
  }

  @Get('quota/:organizationId')
  @ApiOperation({ 
  summary: 'Get usage and quota status',
  description: 'Returns the number of credits used, remaining balance, and the next reset date.' 
})
@ApiOkResponse({ 
  description: 'Quota status retrieved successfully.'
})
  async getQuota(@Param('organizationId') organizationId: string) {
    return this.quotaService.getMonthlyUsageCount(organizationId);
  }
}
