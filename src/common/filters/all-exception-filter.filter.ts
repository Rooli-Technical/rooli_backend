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

    const httpStatus =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    // Get the Exception Body
    let errorDetails: any = null;
    let message = 'Internal server error';

    if (exception instanceof HttpException) {
      const response = exception.getResponse();

      if (typeof response === 'object' && response !== null) {
        errorDetails = response;
        message = (response as any).message || exception.message;
      } else {
        message = response as string;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    const responseBody = {
      statusCode: httpStatus,
      timestamp: new Date().toISOString(),
      path: httpAdapter.getRequestUrl(ctx.getRequest()),
      message: message, // Main message
      ...(errorDetails && typeof errorDetails === 'object' ? errorDetails : {}),
    };

    httpAdapter.reply(ctx.getResponse(), responseBody, httpStatus);
  }
}
