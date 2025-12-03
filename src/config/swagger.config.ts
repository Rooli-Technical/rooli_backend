import { DocumentBuilder } from '@nestjs/swagger';

export const swaggerConfig = new DocumentBuilder()
  .setTitle('Rooli Backend API')
.setDescription(
    'Rooli is a multi-platform social scheduling and content automation system. ' +
    'This API powers user management, workspace/organization workflows, post scheduling, ' +
    'AI-driven content generation, media asset handling, analytics tracking, and platform integrations (Instagram, Facebook Pages, LinkedIn, X).'
  )
  .setVersion('1.0.0')
  .addBearerAuth({
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
    description: 'Use your JWT token to access protected endpoints.'
  })
  .build();