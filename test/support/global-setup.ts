import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { applyTestEnv } from './env';

const run = promisify(execFile);

/**
 * Brings the test database in line with the schema, once per run.
 *
 * Here rather than in a script the developer has to remember: a suite run
 * against last week's schema fails in ways that look like broken code, and the
 * time lost to that is worse than the second this costs.
 *
 * `migrate deploy` rather than `db push`, so every test run is also a test that
 * the migrations apply cleanly to an empty database. Pushing the schema directly
 * would leave the migrations themselves unexercised until a deploy — which is
 * the worst moment to find out one of them does not apply.
 *
 * A test database created before the migrations existed has the tables but no
 * migration history, and this will refuse it. `npm run db:test:down &&
 * npm run db:test:up` starts a clean one.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();

  await run('npx', ['prisma', 'migrate', 'deploy'], {
    shell: process.platform === 'win32',
    // `prisma.config.ts` reads the URL from the environment, and `applyTestEnv`
    // has just pointed that at the test database.
    env: process.env,
  });
}
