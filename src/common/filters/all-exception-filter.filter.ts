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
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
  ) {}

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

    if (exception instanceof HttpException) {
      const response = exception.getResponse();

      if (typeof response === 'object') {
        message =
          (response as any).message || 'Request failed';
        code = (response as any).code || 'REQUEST_FAILED';
      } else {
        message = response;
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
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(ctx.getRequest()),
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}