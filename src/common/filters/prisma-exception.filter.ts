import { Prisma } from '@generated/client';
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    console.error(exception);

    let status = 500;
    let message = 'Database error';
    let code = 'DB_ERROR';

    switch (exception.code) {
      case 'P2002':
        status = 409;
        message = 'Resource already exists';
        code = 'DUPLICATE_RESOURCE';
        break;

      case 'P2025':
        status = 404;
        message = 'Resource not found';
        code = 'NOT_FOUND';
        break;

      case 'P2003':
        status = 400;
        message = 'Invalid reference';
        code = 'FOREIGN_KEY_ERROR';
        break;

      default:
        status = 500;
        message = 'Internal server error';
        code = 'INTERNAL_DB_ERROR';
    }

    response.status(status).json({
      statusCode: status,
      code,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
