import { Prisma } from '@generated/client';
import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';

@Catch(Prisma.PrismaClientKnownRequestError)
export class PrismaExceptionFilter implements ExceptionFilter {
  catch(exception: Prisma.PrismaClientKnownRequestError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    switch (exception.code) {
      case 'P2002':
        response.status(409).json({
          statusCode: 409,
          message: 'Resource already exists',
          error: 'Conflict',
        });
        break;
      case 'P2025':
        response.status(404).json({
          statusCode: 404,
          message: 'Resource not found',
          error: 'Not Found',
        });
        break;
      default:
        response.status(500).json({
          statusCode: 500,
          message: 'Internal server error',
          error: 'Internal Server Error',
        });
    }
  }
}
