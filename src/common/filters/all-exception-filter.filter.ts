import {
  Catch,
  ExceptionFilter,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const isProduction = process.env.NODE_ENV === 'production';

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    let message = 'Internal server error';
    let code = 'INTERNAL_ERROR';
    
    // 🚨 NEW: A place to hold your custom upgrade metadata
    let extraData: Record<string, any> = {};

    if (exception instanceof HttpException) {
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null) {
        const resObj = response as any;
        
        // Handle class-validator arrays or standard strings
        message = Array.isArray(resObj.message) 
          ? resObj.message[0] 
          : resObj.message || 'Request failed';
        
        // 🚨 FIX: Check for 'errorCode' (what you used) OR 'code'
        code = resObj.errorCode || resObj.code || 'REQUEST_FAILED';

        // 🚨 NEW: Catch the billing flags!
        if (resObj.requiresUpgrade) {
          extraData.requiresUpgrade = resObj.requiresUpgrade;
          extraData.feature = resObj.feature;
        }
      } else {
        message = response as string;
      }
    } else {
      // 🔒 NEVER leak internal errors
      message = isProduction
        ? 'An unexpected error occurred'
        : (exception as any)?.message;
    }

    // ✅ LOG EVERYTHING
    console.error(exception);

    const responseBody = {
      statusCode: httpStatus,
      code,
      message,
      ...extraData, // 🚨 Inject the magic flags into the final response!
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(ctx.getRequest()),
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}