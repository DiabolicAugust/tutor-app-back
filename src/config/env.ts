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
  /**
   * Comma-separated list of origins a browser may call this API from.
   *
   * Optional, and what it defaults to depends on where it is running — see
   * `corsOriginsFor` below. Left as one value with one default, the choice was
   * between a development default that is wrong in production and a production
   * requirement that turns every deploy into a dashboard errand.
   */
  CORS_ORIGINS: z.string().optional(),
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
   * This API's own public base URL, used to build the OAuth redirect.
   *
   * It has to match what is registered with Zoom and Google **exactly**, which
   * is why it is configured rather than derived from the incoming request: a
   * redirect built from a `Host` header is both spoofable and, behind a proxy,
   * usually wrong.
   *
   * Optional, because everything except connecting a meeting account works
   * without it.
   */
  PUBLIC_API_URL: z.string().url().optional(),
  /**
   * Where the browser is sent once a provider has been connected.
   *
   * The app's own scheme, so the tab closes back into Settings rather than
   * leaving somebody looking at a blank page wondering whether it worked.
   */
  MEETING_CONNECTED_URL: z.string().default('foxacademy://settings'),
  /**
   * The key that encrypts stored refresh tokens — see `token-cipher.ts`.
   *
   * **Changing it makes every existing connection unreadable**, which is
   * survivable (tutors reconnect) but not silent, so it should be generated once
   * and kept. Long, because it is stretched to a key rather than used directly
   * and its entropy is the only thing protecting a set of credentials to other
   * people's accounts.
   */
  MEETING_TOKEN_SECRET: z
    .string()
    .min(32, 'MEETING_TOKEN_SECRET must be at least 32 characters')
    .optional(),
  /**
   * Credentials for the OAuth apps.
   *
   * Optional individually: a deployment with only Zoom registered offers Zoom
   * and says the other is unavailable, rather than refusing to boot. What is not
   * optional is the pair — an id without a secret is a misconfiguration that
   * would surface as a failed exchange much later, so the check below refuses
   * it at startup.
   */
  ZOOM_CLIENT_ID: z.string().optional(),
  ZOOM_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
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
   * `log` writes them to the server log instead of sending, which is what makes
   * the whole path testable with no Firebase project and no device.
   *
   * `fcm` talks to Firebase Cloud Messaging directly. Deliberately not through
   * Expo's push service: that would mean an Expo account, a second copy of these
   * same credentials held by somebody else, and their rate limits, for a hop that
   * adds nothing — the app registers its native FCM token, so there is no
   * translation to do.
   */
  PUSH_TRANSPORT: z.enum(['log', 'fcm']).default('log'),
  /**
   * A Google service-account key, as JSON.
   *
   * The whole file rather than a path: the host this runs on has an ephemeral
   * filesystem and an environment, and only one of those survives a deploy.
   * Required when `PUSH_TRANSPORT=fcm`; the project id is read from it, so there
   * is no second variable to keep in step.
   */
  FCM_SERVICE_ACCOUNT: z.string().optional(),
  /**
   * Largest accepted upload.
   *
   * A limit rather than none: without one, a single request decides how much
   * disk the server has, and the failure arrives as a full volume rather than a
   * rejected request.
   */
  /**
   * The ceiling is not arbitrary. `File.sizeBytes` is a 32-bit integer, so a
   * single file's recorded size cannot exceed about two gigabytes — and long
   * before that, a request this process buffers in memory decides how much
   * memory it needs. Raising this past a hundred means changing both.
   */
  MAX_UPLOAD_MB: z.coerce.number().int().positive().max(100).default(10),
  /**
   * How much one school may store in total.
   *
   * The per-file limit bounds a single request; this bounds the account. Without
   * it an ordinary signed-in user can upload allowed files of allowed size until
   * the disk or the bill runs out, which is the same denial of service arriving
   * slowly.
   */
  MAX_SCHOOL_STORAGE_MB: z.coerce.number().int().positive().default(2_048),
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

export type Env = Omit<z.infer<typeof envSchema>, 'CORS_ORIGINS'> & {
  CORS_ORIGINS: string;
};

/**
 * What cross-origin access defaults to when nothing says.
 *
 * **Production closes.** No browser client exists yet — the mobile app is native,
 * and native requests are not subject to CORS at all — so an unset variable
 * should mean "no page may call this", not "any page may". An explicit `*` is
 * still refused outright: defaulting to closed and *choosing* to be wide open are
 * different mistakes, and only the second one is worth stopping a boot for.
 *
 * **Development opens**, because the web build is served from a different port
 * and there is nothing to protect on a laptop.
 */
/** OAuth apps, as the pairs they have to be configured in. */
const MEETING_OAUTH_PAIRS = [
  ['ZOOM_CLIENT_ID', 'ZOOM_CLIENT_SECRET'],
  ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
] as const;

function corsOriginsFor(
  configured: string | undefined,
  nodeEnv: Env['NODE_ENV'],
): string {
  if (configured !== undefined) return configured;
  return nodeEnv === 'production' ? '' : '*';
}

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

  const env: Env = {
    ...result.data,
    CORS_ORIGINS: corsOriginsFor(
      result.data.CORS_ORIGINS,
      result.data.NODE_ENV,
    ),
  };

  if (
    result.data.PUSH_TRANSPORT === 'fcm' &&
    !result.data.FCM_SERVICE_ACCOUNT
  ) {
    throw new Error(
      [
        'Invalid environment configuration:',
        '  - FCM_SERVICE_ACCOUNT: required when PUSH_TRANSPORT=fcm',
      ].join('\n'),
    );
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

  // A half-configured OAuth app fails at the exchange, long after boot and in
  // front of a tutor. Checked as pairs here, where the fix is obvious.
  const halfPairs = MEETING_OAUTH_PAIRS.filter(
    ([id, secret]) => Boolean(result.data[id]) !== Boolean(result.data[secret]),
  );
  if (halfPairs.length > 0) {
    throw new Error(
      [
        'Invalid environment configuration:',
        ...halfPairs.map(
          ([id, secret]) => `  - ${id} and ${secret}: set both, or neither`,
        ),
      ].join('\n'),
    );
  }

  // Credentials with nowhere to send the browser back to, or nowhere safe to
  // keep what comes back. Both are needed before any provider can be connected,
  // and both are cheap to get right at boot.
  const configuredProviders = MEETING_OAUTH_PAIRS.some(
    ([id]) => result.data[id],
  );
  if (configuredProviders) {
    const missing = (
      ['PUBLIC_API_URL', 'MEETING_TOKEN_SECRET'] as const
    ).filter((key) => !result.data[key]);

    if (missing.length > 0) {
      throw new Error(
        [
          'Invalid environment configuration:',
          ...missing.map(
            (key) =>
              `  - ${key}: required once a meeting provider is configured`,
          ),
        ].join('\n'),
      );
    }
  }

  return env;
}
