import { applyTestEnv } from './env';

// Runs before each test file, so `ConfigModule` sees the test values rather than
// whatever `.env` happens to hold.
applyTestEnv();
