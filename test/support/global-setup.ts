import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { applyTestEnv } from './env';

const run = promisify(execFile);

/**
 * Brings the test database in line with the schema, once per run.
 *
 * Here rather than in a script the developer has to remember: a suite run
 * against last week's schema fails in ways that look like broken code, and the
 * time lost to that is worse than the 200ms this costs.
 *
 * `db push` rather than `migrate deploy` because this project has no migration
 * history yet. Once it does, this is the line to change — and the tests will
 * then also be proving the migrations apply cleanly, which is worth having.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();

  await run(
    'npx',
    ['prisma', 'db', 'push', '--url', process.env.DATABASE_URL as string],
    { shell: process.platform === 'win32' },
  );
}
