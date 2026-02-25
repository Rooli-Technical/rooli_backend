import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { swaggerConfig } from './common/config/swagger.config';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exception-filter.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as express from 'express';
import { IoAdapter } from '@nestjs/platform-socket.io';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.useWebSocketAdapter(new IoAdapter(app));

app.enableCors({
  origin: true, // reflect request origin
  credentials: true,
});

  app.setGlobalPrefix('api');

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  app.use(
    express.json({
      verify: (req: any, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    }),
  );

  

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

const server = app.getHttpAdapter().getInstance();
server.set('trust proxy', true);

 await app.init();
   
await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
