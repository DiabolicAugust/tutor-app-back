import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';

import { PrismaExceptionFilter } from './common/filters/prisma-exception.filter';
import type { Env } from './config/env';

/**
 * Everything that turns a bare Nest application into *this* application.
 *
 * Extracted from `main.ts` so the tests can boot the same thing the server
 * boots. Validation, the global prefix and the Prisma filter all change what a
 * request does and what status it comes back with — a test suite that skipped
 * them would be exercising an app that does not exist in production, and would
 * pass while real requests failed.
 */
export function configureApp(app: INestApplication): INestApplication {
  const config = app.get(ConfigService<Env, true>);

  app.setGlobalPrefix('api');

  // `whitelist` strips properties the DTO does not declare and
  // `forbidNonWhitelisted` rejects them outright, so a client cannot smuggle
  // fields past validation.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.useGlobalFilters(
    new PrismaExceptionFilter(app.get(HttpAdapterHost).httpAdapter),
  );

  const origins = config.get('CORS_ORIGINS', { infer: true });
  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
  });

  app.enableShutdownHooks();

  return app;
}
