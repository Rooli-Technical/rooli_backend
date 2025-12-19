import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { swaggerConfig } from './config/swagger.config';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { LoggerMiddleware } from './common/middlewares/logger.middleware';
import * as bodyParser from 'body-parser';
import { BullBoardModule } from './common/bull-boad/bull-board.module';
import { AllExceptionsFilter } from './common/filters/all-exception-filter.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.enableCors();
  app.setGlobalPrefix('api');

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // Mount Bull Board outside global prefix/versioning
  const bullBoardModule = app.get(BullBoardModule);
  bullBoardModule.mount(app);

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  });


  // Global validation
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const httpAdapter = app.get(HttpAdapterHost);

  app.useGlobalInterceptors(new TransformInterceptor());

  app.useGlobalFilters(
    new PrismaExceptionFilter(),
    new AllExceptionsFilter(httpAdapter),
  );


  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
