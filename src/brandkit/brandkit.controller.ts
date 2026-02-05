import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UsePipes, ValidationPipe } from '@nestjs/common';
import { BrandKitService } from './brandkit.service';
import { ApiTags, ApiOperation, ApiParam, ApiResponse, ApiBody } from '@nestjs/swagger';
import { CreateBrandKitDto } from './dto/create-brandkit.dto';
import { UpdateBrandKitDto } from './dto/update-brandkit.dto';

  @ApiTags('Brand Kit')
@Controller('workspaces/:workspaceId/brand-kit')
export class BrandkitController {
  constructor(private readonly service: BrandKitService) {}

  @Get()
  @ApiOperation({ summary: 'Get brand kit for a specific workspace' })
  @ApiParam({ name: 'workspaceId', description: 'The CUID of the workspace' })
  @ApiResponse({ status: 200, description: 'Return the brand kit object.' })
  @ApiResponse({ status: 404, description: 'Brand kit not found.' })
  async getKit(@Param('workspaceId') workspaceId: string) {
    return this.service.getByWorkspace(workspaceId);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Create or update (upsert) brand kit' })
  @ApiParam({ name: 'workspaceId', description: 'The UUID of the workspace' })
  @ApiBody({ type: CreateBrandKitDto }) // Or a union type if preferred
  @ApiResponse({ status: 200, description: 'Brand kit successfully upserted.' })
  @ApiResponse({ status: 400, description: 'Invalid color format or data.' })
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async upsertKit(
    @Param('workspaceId') workspaceId: string,
    @Body() dto: CreateBrandKitDto | UpdateBrandKitDto,
  ) {
    return this.service.upsertForWorkspace(workspaceId, dto);
  }

  @Post('ensure-default')
  @ApiOperation({ summary: 'Ensure a default brand kit exists (initializes if missing)' })
  @ApiResponse({ status: 201, description: 'Default kit confirmed or created.' })
  async ensureDefault(@Param('workspaceId') workspaceId: string) {
    return this.service.ensureDefaultExists(workspaceId);
  }
}
