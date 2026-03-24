import { Controller, Get, Query, Res, BadRequestException, Logger } from '@nestjs/common';
import { Response } from 'express';
import axios from 'axios';

@Controller('media')
export class MediaProxyController {
  private readonly logger = new Logger(MediaProxyController.name);

  @Get('proxy')
  async proxyImage(@Query('url') url: string, @Res() res: Response) {
    if (!url) {
      throw new BadRequestException('Image URL is required');
    }

    try {
      // 1. Fetch the binary image stream from Cloudinary
      const response = await axios.get(url, { responseType: 'stream' });
      
      // 2. Pass the correct image headers directly to TikTok
      res.setHeader('Content-Type', response.headers['content-type']);
      
      // 3. Pipe the binary data directly to TikTok's servers
      response.data.pipe(res);
      
    } catch (error) {
      this.logger.error(`Failed to proxy image: ${url}`);
      res.status(500).send('Failed to fetch media');
    }
  }
}