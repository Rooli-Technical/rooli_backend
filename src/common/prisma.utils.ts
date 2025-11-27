
import { Prisma } from '@generated/client';
import {
  ConflictException,
  NotFoundException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';

export function handlePrismaError(err: unknown): never {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) {
    throw new InternalServerErrorException('Database error');
  }

  switch (err.code) {
    case 'P2002': // Unique constraint failed
      throw new ConflictException('Resource already exists');
    case 'P2025': // Record to update/delete does not exist.
      throw new NotFoundException('Resource not found');
    case 'P2003': // Foreign key constraint failed
      throw new BadRequestException('Related resource not found');
    default:
      throw new InternalServerErrorException('Database error');
  }
}