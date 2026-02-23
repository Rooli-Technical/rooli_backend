import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { swaggerConfig } from './common/config/swagger.config';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exception-filter.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as express from 'express';
import { EventsGateway } from './events/events.gateway';
import { WsAuthMiddleware } from './events/ws-auth.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

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

  await app.init();

   // Attach Socket.io auth middleware
  const wsAuth = app.get(WsAuthMiddleware);
  const gateway = app.get(EventsGateway);

  // gateway.server is available after init for Nest gateways
  gateway.server.use(wsAuth.use);

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

await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
