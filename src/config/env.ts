import { z } from 'zod';

/**
 * Environment contract.
 *
 * Validated once at boot and never read from `process.env` again: a missing
 * secret should stop the process on startup, not surface as a 500 the first
 * time someone signs in.
 */
const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  /** Signing secret for access tokens. */
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  /** Access token lifetime, as an `ms`-style duration. */
  JWT_EXPIRES_IN: z.string().default('7d'),
  /** Comma-separated list, or `*` in development. */
  CORS_ORIGINS: z.string().default('*'),
  /**
   * `log` writes emails to the server log instead of sending them — the only
   * supported value until a provider is wired up.
   */
  MAIL_TRANSPORT: z.enum(['log']).default('log'),
  /**
   * Base for invitation links. The app's scheme, so tapping the link in a phone
   * mail client opens the app rather than a browser.
   */
  INVITE_URL_BASE: z.string().default('foxacademy://invite'),
  /** How long an invitation stays valid. */
  INVITE_TTL_HOURS: z.coerce.number().int().positive().default(72),
  /** Where support requests are forwarded once a mail provider exists. */
  SUPPORT_EMAIL: z.string().email().default('support@foxacademy.dev'),
  /**
   * Where uploaded files are kept.
   *
   * `local` is a directory, which is what a single server needs and what the
   * tests use. `s3` is any S3-compatible bucket — AWS, Cloudflare R2, Backblaze,
   * MinIO — and is what a platform with an **ephemeral filesystem** needs:
   * without it, uploads disappear on every redeploy while their database rows
   * stay behind, and nothing reports an error.
   */
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  /** Used by the `local` driver only. */
  UPLOADS_DIR: z.string().default('./uploads'),
  /** Bucket name. Required when `STORAGE_DRIVER=s3`; see the check below. */
  S3_BUCKET: z.string().optional(),
  /**
   * Endpoint of the S3-compatible service.
   *
   * Omitted for AWS itself, where the SDK derives it from the region. Required
   * for anything else — R2's looks like
   * `https://<account-id>.r2.cloudflarestorage.com`.
   */
  S3_ENDPOINT: z.string().url().optional(),
  /**
   * Region. `auto` for R2, which ignores it but requires a value.
   */
  S3_REGION: z.string().default('auto'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * How push notifications leave the server.
   *
   * `log` writes them to the server log instead of sending — the only supported
   * value until credentials exist, and what makes the whole path testable with no
   * Firebase project and no device.
   */
  PUSH_TRANSPORT: z.enum(['log', 'expo']).default('log'),
  /**
   * Optional Expo access token, for a project with "enhanced security" enabled.
   * Sending works without one for most projects.
   */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /**
   * Largest accepted upload.
   *
   * A limit rather than none: without one, a single request decides how much
   * disk the server has, and the failure arrives as a full volume rather than a
   * rejected request.
   */
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(10),
});

/**
 * What `s3` needs on top of choosing it.
 *
 * Checked as a cross-field rule rather than by making the fields required,
 * because they are genuinely optional for the `local` driver — and checked at
 * *boot* rather than at first use, because the alternative is a server that
 * starts happily and then fails the first upload somebody actually cares about.
 */
const S3_REQUIRED = [
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
] as const;

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates the environment. Passed to `ConfigModule` as its
 * `validate` hook, so Nest refuses to start on a bad configuration.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map(
        (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  if (result.data.STORAGE_DRIVER === 's3') {
    const missing = S3_REQUIRED.filter((key) => !result.data[key]);
    if (missing.length > 0) {
      throw new Error(
        [
          'Invalid environment configuration:',
          ...missing.map(
            (key) => `  - ${key}: required when STORAGE_DRIVER=s3`,
          ),
        ].join('\n'),
      );
    }
  }

  return result.data;
}
