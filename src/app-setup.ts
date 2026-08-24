import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpAdapterHost } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';

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
  const isProduction = config.get('NODE_ENV', { infer: true }) === 'production';

  app.setGlobalPrefix('api');

  /**
   * Trust the platform's proxy for the client address.
   *
   * Without this every request on a hosted deployment appears to come from the
   * load balancer, so anything counted per address counts the whole internet as
   * one caller — the rate limiter would lock out every user together the first
   * time one of them misbehaved.
   *
   * One hop, not `true`. `trust proxy: true` accepts the leftmost value of an
   * `X-Forwarded-For` header, which the client writes, so a caller could claim a
   * new address per request and have no limit at all. Counting one hop back from
   * this process takes the address the platform's own proxy observed, which a
   * client cannot forge.
   */
  (app as NestExpressApplication).set('trust proxy', 1);

  /**
   * A ceiling on request bodies.
   *
   * Express defaults to 100 kB for JSON, which is already a limit, but it is not
   * applied to what this app actually accepts: uploads arrive as multipart and
   * are bounded separately, at the interceptor, so this only has to be large
   * enough for the largest legitimate JSON payload. A written-up lesson with a
   * register is a few kilobytes.
   */
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ limit: '64kb', extended: true }));

  /**
   * Response headers that cost nothing and remove whole classes of problem.
   *
   * `contentSecurityPolicy` is off: this process serves JSON and file downloads,
   * never a page, so there is no document for a policy to govern — and a default
   * policy on an API only shows up in the browser console of whoever is
   * debugging it. `crossOriginResourcePolicy` is relaxed to `cross-origin`
   * because the web build is served from a different origin than the API and
   * would otherwise be unable to read its own downloads.
   */
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

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

  /**
   * Cross-origin access, and a refusal to be wide open in production.
   *
   * `*` is the right default for development and the wrong one for a deployment,
   * and the difference is easy to miss because nothing breaks when it is wrong.
   * The mobile app is unaffected either way — native requests are not subject to
   * CORS at all — so this is entirely about the web build and about any page
   * that would like to make requests with a user's browser.
   *
   * Refused at boot rather than silently narrowed: a server that will not start
   * is a problem somebody fixes, and a server that quietly stopped serving the
   * web build is a problem somebody debugs.
   */
  const origins = config.get('CORS_ORIGINS', { infer: true });
  if (isProduction && origins.trim() === '*') {
    throw new Error(
      'CORS_ORIGINS must list the allowed origins in production, not "*".',
    );
  }

  app.enableCors({
    origin: origins === '*' ? true : origins.split(',').map((o) => o.trim()),
    // No cookies are used — the session travels in an Authorization header — so
    // credentials stay off and a hostile page cannot ride an existing session.
    credentials: false,
    maxAge: 86_400,
  });

  app.enableShutdownHooks();

  return app;
}
