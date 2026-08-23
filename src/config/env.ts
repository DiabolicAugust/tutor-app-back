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
   * A directory because that is what a single server needs, and object storage
   * is a different implementation of the same seam rather than a different
   * shape of configuration — see `storage.service.ts`.
   */
  UPLOADS_DIR: z.string().default('./uploads'),
  /**
   * Largest accepted upload.
   *
   * A limit rather than none: without one, a single request decides how much
   * disk the server has, and the failure arrives as a full volume rather than a
   * rejected request.
   */
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(10),
});

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

  return result.data;
}
