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

  describe('storage', () => {
    it('keeps files on the local disk unless told otherwise', () => {
      const env = validateEnv({ ...valid });

      expect(env.STORAGE_DRIVER).toBe('local');
      expect(env.UPLOADS_DIR).toBe('./uploads');
    });

    it('needs a bucket and credentials before it will use one', () => {
      // The whole point of checking at boot: a server that starts without these
      // would accept uploads and lose them, and nothing would report it.
      expect(() => validateEnv({ ...valid, STORAGE_DRIVER: 's3' })).toThrow(
        /S3_BUCKET/,
      );
    });

    it('names every missing piece at once, not the first one', () => {
      let message = '';
      try {
        validateEnv({ ...valid, STORAGE_DRIVER: 's3', S3_BUCKET: 'fox' });
      } catch (cause) {
        message = cause instanceof Error ? cause.message : String(cause);
      }

      // One boot, one list. Fixing these one redeploy at a time is the failure
      // mode this avoids.
      expect(message).toContain('S3_ACCESS_KEY_ID');
      expect(message).toContain('S3_SECRET_ACCESS_KEY');
    });

    it('accepts a complete object-store configuration', () => {
      const env = validateEnv({
        ...valid,
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'fox-uploads',
        S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com',
        S3_ACCESS_KEY_ID: 'key',
        S3_SECRET_ACCESS_KEY: 'secret',
      });

      expect(env).toMatchObject({
        STORAGE_DRIVER: 's3',
        S3_BUCKET: 'fox-uploads',
        // Defaulted, because R2 ignores the region but the SDK insists on one.
        S3_REGION: 'auto',
      });
    });

    it('refuses an endpoint that is not a URL', () => {
      expect(() =>
        validateEnv({
          ...valid,
          STORAGE_DRIVER: 's3',
          S3_BUCKET: 'fox',
          S3_ENDPOINT: 'account.r2.cloudflarestorage.com',
          S3_ACCESS_KEY_ID: 'key',
          S3_SECRET_ACCESS_KEY: 'secret',
        }),
      ).toThrow(/S3_ENDPOINT/);
    });

    it('does not demand S3 settings for the local driver', () => {
      expect(() =>
        validateEnv({ ...valid, STORAGE_DRIVER: 'local' }),
      ).not.toThrow();
    });
  });
});
