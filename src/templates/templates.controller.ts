import {
  UseGuards,
  Controller,
  Post,
  Body,
  Req,
  Get,
  Param,
  Query,
  Put,
  Delete,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
} from '@nestjs/swagger';
import { ContentTemplatesService } from './templates.service';
import { CreateTemplateDto } from './dtos/create-template.dto';
import { GenerateFromTemplateDto } from './dtos/generate-from-template.dto';
import { UpdateTemplateDto } from './dtos/update-template.dto';
import { TemplateFilterDto } from './dtos/get-org-templates.dto';
import { GetSystemTemplatesDto } from './dtos/get-system-template.dto';
import { JwtAuthGuard } from '@/common/guards/jwt-auth.guard';

@ApiTags('Content Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('templates')
export class ContentTemplatesController {
  constructor(private readonly templatesService: ContentTemplatesService) {}

  // CREATE
  @Post()
  @ApiOperation({ summary: 'Create a new template' })
  @ApiResponse({ status: 201, description: 'Template successfully created' })
  create(
    @Body() dto: CreateTemplateDto,
    @Req() req: any, // assume req.user contains { id, organizationId }
  ) {
    return this.templatesService.createTemplate(
      req.user.id,
      dto,
    );
  }

  // GET ORG TEMPLATES
  @Get(':organizationId')
  @ApiOperation({ summary: 'List organization templates' })
  getOrgTemplates(@Param('organizationId') organizationId: string, @Query() query:TemplateFilterDto ) {
    return this.templatesService.getOrganizationTemplates(
      organizationId,
      query
    );
  }

  // GET SYSTEM TEMPLATES
  @Get('system/all')
  @ApiOperation({ summary: 'List system templates' })
  getSystemTemplates(@Query() query: GetSystemTemplatesDto) {
    return this.templatesService.getSystemTemplates(query);
  }

  // UPDATE
  @Put(':id/:organizationId')
  @ApiOperation({ summary: 'Update a template' })
  update(
    @Param('id') id: string,
    @Param('organizationId') organizationId: string,
    @Body() dto: UpdateTemplateDto,
    @Req() req: any,
  ) {
    return this.templatesService.updateTemplate(
      id,
      organizationId,
      dto,
    );
  }

  // DELETE
  @Delete(':id/:organizationId')
  @ApiOperation({ summary: 'Delete a template' })
  delete(@Param('id') id: string, @Param('organizationId') organizationId: string,) {
    return this.templatesService.deleteTemplate(id, organizationId);
  }

  // GENERATE FROM TEMPLATE
  @Post(':id/:organizationId/generate')
  @ApiOperation({ summary: 'Generate content from a template' })
  generateFromTemplate(
    @Param('id') id: string,
    @Param('organizationId') organizationId: string,
    @Body() dto: GenerateFromTemplateDto,
    @Req() req: any,
  ) {
    return this.templatesService.generateFromTemplate(
      id,
      dto,
      organizationId,
      req.user.id,
    );
  }

  // FAVORITE
  @Post(':id/favorite')
  @ApiOperation({ summary: 'Favorite a template' })
  favorite(@Param('id') id: string, @Req() req: any) {
    return this.templatesService.favoriteTemplate(id, req.user.id);
  }

  // UNFAVORITE
  @Delete(':id/favorite')
  @ApiOperation({ summary: 'Unfavorite a template' })
  unfavorite(@Param('id') id: string, @Req() req: any) {
    return this.templatesService.unfavoriteTemplate(id, req.user.id);
  }

  // USER FAVORITES
  @Get(':organizationId/user/favorites')
  @ApiOperation({ summary: 'Get user favorite templates' })
  getUserFavorites(@Req() req: any, @Param('organizationId') organizationId: string) {
    return this.templatesService.getUserFavorites(
      req.user.id,
      organizationId,
    );
  }

  // DUPLICATE
  @Post(':id/:organizationId/duplicate')
  @ApiOperation({ summary: 'Duplicate a template' })
  duplicate(
    @Param('id') id: string,
    @Param('organizationId') organizationId: string,
    @Body('newName') newName: string,
    @Req() req: any,
  ) {
    return this.templatesService.duplicateTemplate(
      id,
      req.user.id,
      organizationId,
      newName,
    );
  }

  // GET ONE
  @Get(':id')
  @ApiOperation({ summary: 'Get template by ID' })
  @ApiResponse({ status: 200, description: 'Template details returned' })
  getOne(@Param('id') id: string, @Req() req: any) {
    return this.templatesService.getTemplateById(id, req.user.organizationId);
  }

}
