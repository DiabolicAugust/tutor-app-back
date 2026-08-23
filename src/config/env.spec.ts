import { validateEnv } from './env';

const valid = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  JWT_SECRET: 'a'.repeat(32),
};

describe('validateEnv', () => {
  it('fills in the values a development machine can be trusted to omit', () => {
    const env = validateEnv({ ...valid });

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      MAIL_TRANSPORT: 'log',
      INVITE_TTL_HOURS: 72,
    });
  });

  it('refuses to start without a database', () => {
    expect(() => validateEnv({ JWT_SECRET: valid.JWT_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('refuses a signing secret short enough to guess', () => {
    // A missing secret must stop the process at boot, not surface as a 500 the
    // first time somebody signs in.
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('reads a port given as a string, because every environment gives strings', () => {
    expect(validateEnv({ ...valid, PORT: '8080' }).PORT).toBe(8080);
  });

  it('refuses a mail transport that does not exist yet', () => {
    // Loud rather than silently dropping mail: a configuration that claims to
    // send and does not is worse than a failure.
    expect(() => validateEnv({ ...valid, MAIL_TRANSPORT: 'ses' })).toThrow(
      /MAIL_TRANSPORT/,
    );
  });

  it('names every problem at once, not just the first', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL[\s\S]*JWT_SECRET/);
  });
});
