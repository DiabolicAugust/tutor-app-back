import type { Server } from 'node:http';

import type { INestApplication } from '@nestjs/common';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';

import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app-setup';
import { PrismaService } from '../../src/prisma/prisma.service';

export type TestApp = {
  app: INestApplication;
  prisma: PrismaService;
  /** The HTTP server supertest attaches to. */
  server: Server;
  /** Empties every table. Called between tests, not between files. */
  reset(): Promise<void>;
  close(): Promise<void>;
};

/**
 * Boots the real application against the test database.
 *
 * Deliberately not a mocked Prisma: most of what this backend enforces *is* a
 * `where` clause — tenant isolation, ownership, the addon join — and a mock
 * would happily confirm that the wrong query was called with the wrong
 * arguments. The rules are only proven against a database that would let a
 * mistake through.
 *
 * `customise` is the seam for the few tests that need to replace a collaborator
 * the outside world owns, such as making the mail transport fail.
 */
export async function createTestApp(
  customise?: (builder: TestingModuleBuilder) => TestingModuleBuilder,
): Promise<TestApp> {
  const base = Test.createTestingModule({ imports: [AppModule] });
  const moduleRef = await (customise ? customise(base) : base).compile();

  const app = configureApp(moduleRef.createNestApplication());
  await app.init();

  const prisma = app.get(PrismaService);

  return {
    app,
    prisma,
    server: app.getHttpServer() as Server,
    reset: () => truncateAll(prisma),
    close: async () => {
      await app.close();
    },
  };
}

/**
 * Empties the schema by asking the database what it contains.
 *
 * Enumerated from the catalog rather than from a hand-written list: a list is a
 * second place to remember a new model, and the failure mode is silent — rows
 * left behind by a table nobody added to the list leak into the next test as a
 * pass that should not have happened.
 */
export async function truncateAll(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename NOT LIKE '_prisma%'
  `;

  if (tables.length === 0) return;

  const list = tables
    .map(({ tablename }) => `"public"."${tablename}"`)
    .join(', ');

  // One statement, CASCADE: the rows reference each other, so truncating them
  // one at a time would need an order that changes every time a relation does.
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}
