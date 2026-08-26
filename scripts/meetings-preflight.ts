/**
 * Proves a real connection works, against the real provider.
 *
 * The test suite drives Zoom and Google through a stand-in that speaks their
 * protocol, which covers every mistake this codebase can make — the grant types,
 * the credentials, token rotation, revocation, the fallbacks. What it cannot
 * cover is whether *their* servers agree: whether the app was registered with
 * the scope we ask for, whether the redirect URI matches to the character,
 * whether the account is allowed to create meetings at all. Every one of those
 * fails at the same place, in front of a tutor, with a message nobody sees.
 *
 * So: connect a provider in the app first, then run this. It takes the stored
 * credential, refreshes it for real, creates a real room, and prints what the
 * provider said.
 *
 *   npx tsx scripts/meetings-preflight.ts tutor@example.com ZOOM
 *
 * A room it creates is a real meeting in that account. Nothing deletes it —
 * deleting would need a wider scope than creating, and asking for one so a script
 * can tidy up after itself is the wrong trade.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../generated/prisma/client';
import { MeetingProvider } from '../generated/prisma/enums';
import {
  DEFAULT_ENDPOINTS,
  OAUTH_PROVIDERS,
  isConnectable,
} from '../src/meetings/oauth-providers';
import { TokenCipher } from '../src/meetings/token-cipher';

async function main(): Promise<void> {
  const [email, providerName] = process.argv.slice(2);

  if (!email || !providerName) {
    fail(
      'Usage: npx tsx scripts/meetings-preflight.ts <email> <ZOOM|GOOGLE_MEET>',
    );
  }

  const provider = providerName.toUpperCase() as MeetingProvider;
  if (!isConnectable(provider)) {
    fail(`${providerName} is not a provider that can be connected.`);
  }

  const prefix = provider === MeetingProvider.ZOOM ? 'ZOOM' : 'GOOGLE';
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const clientSecret = process.env[`${prefix}_CLIENT_SECRET`];
  const secret = process.env.MEETING_TOKEN_SECRET;

  if (!clientId || !clientSecret) {
    fail(`${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET are not both set.`);
  }
  if (!secret) fail('MEETING_TOKEN_SECRET is not set.');

  console.log(`Redirect URI this server will send: ${redirectUri(provider)}`);
  console.log('It has to match what is registered, exactly.\n');

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) fail(`No account for ${email}.`);

    const account = await prisma.meetingAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider } },
    });
    if (!account) {
      fail(
        `${email} has not connected ${provider}. Do that in the app first — Settings, Online lessons.`,
      );
    }

    const refreshToken = new TokenCipher(secret).decrypt(account.refreshToken);
    if (refreshToken === null) {
      fail(
        'The stored credential could not be decrypted. MEETING_TOKEN_SECRET has probably changed since it was stored; reconnect in the app.',
      );
    }

    console.log('Refreshing the access token...');
    const tokens = await exchange(provider, clientId, clientSecret, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    console.log(`  got one, good for ${tokens.expiresIn}s`);
    if (tokens.refreshToken !== null) {
      // Zoom rotates. This script does not write the new one back, so say so —
      // otherwise the next booking fails and this script looks like the cause.
      console.log(
        '  the provider rotated the refresh token, and this script does not store it,',
      );
      console.log(
        '  so reconnect in the app before booking anything on this account.',
      );
    }

    console.log('\nCreating a room...');
    const url = await OAUTH_PROVIDERS[provider].createRoom({
      api: DEFAULT_ENDPOINTS[provider].api,
      accessToken: tokens.accessToken,
      topic: 'Fox Academy preflight',
      startsAt: new Date(Date.now() + 60 * 60 * 1000),
      durationMinutes: 30,
    });

    console.log(`  ${url}`);
    console.log('\nThe integration works. Delete that meeting when you like.');
  } finally {
    await prisma.$disconnect();
  }
}

/** The same shape the service uses, kept short here rather than shared: this
 *  script exists to check the provider, and importing the Nest service would
 *  bring a whole application's worth of wiring with it. */
async function exchange(
  provider: 'ZOOM' | 'GOOGLE_MEET',
  clientId: string,
  clientSecret: string,
  form: Record<string, string>,
): Promise<{ accessToken: string; refreshToken: string | null; expiresIn: number }> {
  const config = OAUTH_PROVIDERS[provider];
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  const body = new URLSearchParams(form);

  if (config.basicAuth) {
    const pair = `${clientId}:${clientSecret}`;
    headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
  } else {
    body.set('client_id', clientId);
    body.set('client_secret', clientSecret);
  }

  const response = await fetch(DEFAULT_ENDPOINTS[provider].token, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    fail(`The token endpoint answered ${response.status}: ${text}`);
  }

  const payload = JSON.parse(text) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) fail(`No access_token in: ${text}`);

  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresIn: payload.expires_in ?? 3600,
  };
}

function redirectUri(provider: MeetingProvider): string {
  const base = (process.env.PUBLIC_API_URL ?? '(PUBLIC_API_URL is not set)')
    .replace(/\/$/, '');
  return `${base}/api/meetings/callback/${provider}`;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
