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
import { RedisIoAdapter } from './events/adapters/redis-io.adapter';


process.on('uncaughtException', (err) => {
  console.error('🚨 [Uncaught Exception] The process is crashing:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 [Unhandled Rejection] A promise failed completely:', reason);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

 const redisClient = app.get('REDIS_CLIENT');
  
  // ONLY the Web Service gets the Adapter!
  const redisIoAdapter = new RedisIoAdapter(app, redisClient);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  //app.useWebSocketAdapter(new IoAdapter(app));

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

(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

const server = app.getHttpAdapter().getInstance();
server.set('trust proxy', true);

 await app.init();
   
await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
