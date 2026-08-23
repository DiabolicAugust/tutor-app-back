import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Environment for the integration suite, applied before Nest reads it.
 *
 * `DATABASE_URL` is **overwritten**, never merely defaulted. These tests
 * truncate every table between cases, so inheriting a developer's URL from
 * `.env` would mean one `npm test` wiping the database they were working in.
 * Overriding is the safe direction: the worst case is a suite that cannot find
 * its database, which is a failed test rather than lost data.
 */
const FALLBACK_DATABASE_URL =
  'postgresql://postgres:fox@localhost:55432/foxacademy_test?schema=public';

/**
 * Where uploads land during a test run.
 *
 * A temporary directory, and set **here** rather than in a `beforeAll`:
 * `ConfigModule.forRoot()` reads the environment when the module is first
 * imported, which happens before any hook in a spec file runs. Setting it later
 * silently has no effect, and the uploads go to the default `./uploads` inside
 * the repository — which is how this was found.
 */
export const TEST_UPLOADS_DIR = join(tmpdir(), 'foxacademy-test-uploads');

export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL =
    process.env.TEST_DATABASE_URL ?? FALLBACK_DATABASE_URL;

  assertLooksLikeTestDatabase(process.env.DATABASE_URL);

  // Deterministic rather than defaulted, so a test asserting on token contents
  // or invite expiry does not depend on the machine it runs on.
  process.env.JWT_SECRET = 'test-only-secret-at-least-thirty-two-chars-long';
  process.env.JWT_EXPIRES_IN = '1h';
  process.env.MAIL_TRANSPORT = 'log';
  process.env.INVITE_URL_BASE = 'foxacademy://invite';
  process.env.INVITE_TTL_HOURS = '72';
  process.env.SUPPORT_EMAIL = 'support@example.test';
  process.env.CORS_ORIGINS = '*';
  process.env.UPLOADS_DIR = TEST_UPLOADS_DIR;
}

/**
 * Refuses to run against a database whose name does not announce itself as a
 * test one. A named convention is a weak guarantee, but it is the one the
 * connection string can actually carry, and it turns "wiped my dev data" from a
 * possibility into a typo the suite catches.
 */
function assertLooksLikeTestDatabase(url: string): void {
  const name = url.split('/').pop()?.split('?')[0] ?? '';

  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to run tests against database "${name}": these tests truncate ` +
        `every table, so the database name must contain "test". Set ` +
        `TEST_DATABASE_URL to a throwaway database.`,
    );
  }
}
