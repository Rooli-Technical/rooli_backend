import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker-app.module';

process.on('uncaughtException', (err) => {
  console.error('🚨 [Uncaught Exception] The process is crashing:', err);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 [Unhandled Rejection] A promise failed completely:', reason);
});

async function bootstrap() {
  // createApplicationContext starts Nest WITHOUT the HTTP Server
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  
  // This enables system signals (like Ctrl+C or Render shutdowns) to close connections gracefully
  app.enableShutdownHooks(); 


  console.log('🚀 Background Worker is listening for jobs...');
}
bootstrap();