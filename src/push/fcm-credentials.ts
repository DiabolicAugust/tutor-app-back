import { createSign } from 'node:crypto';

/**
 * The parts of a Google service-account key this needs.
 *
 * A structural check rather than a schema: the file has a dozen fields and three
 * of them matter, so the rest is somebody else's business.
 */
export type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

/** What FCM sending is authorised against. */
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const AUDIENCE = TOKEN_URL;
/** Google issues hour-long tokens; renewed early so none is used as it expires. */
const LIFETIME_SECONDS = 3600;
const RENEW_MARGIN_MS = 5 * 60 * 1000;

export function parseServiceAccount(raw: string): ServiceAccount {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('FCM_SERVICE_ACCOUNT is not valid JSON.');
  }

  const account = parsed as Partial<ServiceAccount>;
  const missing = (
    ['project_id', 'client_email', 'private_key'] as const
  ).filter((key) => typeof account[key] !== 'string' || !account[key]);

  if (missing.length > 0) {
    throw new Error(
      `FCM_SERVICE_ACCOUNT is missing: ${missing.join(', ')}. ` +
        'Use the whole JSON key from Firebase → Project settings → Service accounts.',
    );
  }

  return {
    project_id: account.project_id!,
    client_email: account.client_email!,
    // Environment variables cannot hold real newlines on most hosts, so the key
    // arrives with them escaped. Left alone if it already has them.
    private_key: account.private_key!.replace(/\n/g, '\n'),
  };
}

/**
 * An OAuth2 access token for the service account, cached until it nearly expires.
 *
 * Hand-rolled rather than `google-auth-library`, and the reason is weight: this
 * is one signed assertion and one POST against a documented, stable grant type,
 * while the library brings a dependency tree that every cold start would have to
 * load — and cold starts on the host this runs on have been measured in tens of
 * seconds. The signing itself is `crypto` doing RS256.
 */
export class AccessTokenCache {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(private readonly account: ServiceAccount) {}

  async get(now: number = Date.now()): Promise<string> {
    if (this.token && now < this.expiresAt - RENEW_MARGIN_MS) return this.token;

    const issued = Math.floor(now / 1000);
    const assertion = sign(
      {
        iss: this.account.client_email,
        scope: SCOPE,
        aud: AUDIENCE,
        iat: issued,
        exp: issued + LIFETIME_SECONDS,
      },
      this.account.private_key,
    );

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });

    if (!response.ok) {
      throw new Error(
        `Could not get an FCM access token (${response.status}): ${await response.text()}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!payload.access_token) {
      throw new Error('The token endpoint answered without an access token.');
    }

    this.token = payload.access_token;
    this.expiresAt = now + (payload.expires_in ?? LIFETIME_SECONDS) * 1000;
    return this.token;
  }
}

/** A signed JWT, in the compact form the grant expects. */
function sign(
  claims: Record<string, string | number>,
  privateKey: string,
): string {
  const encode = (value: object): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey, 'base64url');

  return `${unsigned}.${signature}`;
}
