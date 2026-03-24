import { Controller, Get, Query, Res, BadRequestException, Logger } from '@nestjs/common';
import { Response } from 'express';
import axios from 'axios';

@Controller()
export class MediaProxyController {
  private readonly logger = new Logger(MediaProxyController.name);

 @Get('tiktok/media')
async streamMedia(@Query('url') url: string, @Res() res: Response) {
  const response = await axios.get(url, {
    responseType: 'stream',
  });

  res.setHeader('Content-Type', response.headers['content-type'] || 'image/jpeg');
  res.setHeader('Content-Length', response.headers['content-length']);

  response.data.pipe(res);
}
}