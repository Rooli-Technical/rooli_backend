import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BadRequestException, ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { swaggerConfig } from './common/config/swagger.config';
import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import { AllExceptionsFilter } from './common/filters/all-exception-filter.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import * as express from 'express';
import {  RedisSocketIoAdapter } from './events/adapters/redis-io.adapter';
import Redis from 'ioredis';


async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  app.enableShutdownHooks();

const redisClient = app.get<Redis>('REDIS_CLIENT');

const pubClient = redisClient;
const subClient = redisClient.duplicate();

const redisAdapter = new RedisSocketIoAdapter(app, pubClient, subClient);

await redisAdapter.connectToRedis();

app.useWebSocketAdapter(redisAdapter);
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
