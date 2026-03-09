import { NestFactory } from '@nestjs/core';
import { WorkerAppModule } from './worker-app.module';

async function bootstrap() {
  // createApplicationContext starts Nest WITHOUT the HTTP Server
  const app = await NestFactory.createApplicationContext(WorkerAppModule);
  
  // This enables system signals (like Ctrl+C or Render shutdowns) to close connections gracefully
  app.enableShutdownHooks(); 


  console.log('🚀 Background Worker is listening for jobs...');
}
bootstrap();