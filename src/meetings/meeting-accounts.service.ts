import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { MeetingAccount, User } from '../../generated/prisma/client';
import { MeetingProvider } from '../../generated/prisma/enums';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  OAUTH_PROVIDERS,
  isConnectable,
  type ConnectableProvider,
  type ProviderEndpoints,
  type TokenSet,
} from './oauth-providers';
import { TokenCipher } from './token-cipher';

/**
 * Where the providers live. Overridden in tests by a server that speaks their
 * protocol — see `oauth-providers.ts` for why that seam exists.
 */
export const MEETING_ENDPOINTS = 'MEETING_ENDPOINTS';

/** How long the browser has to complete a connection before the state expires. */
const STATE_TTL_SECONDS = 600;

/**
 * A token is refreshed this long before it actually expires.
 *
 * Booking a lesson with a token that dies in the next second is a failed room
 * and a confused tutor; a minute of slack costs nothing.
 */
const EXPIRY_SLACK_MS = 60_000;

/** What the app is told about a connection. Never the credential itself. */
export type MeetingConnection = {
  provider: ConnectableProvider;
  /** Who they connected as, when the provider said. */
  accountLabel: string | null;
  connectedAt: string;
};

@Injectable()
export class MeetingAccountsService {
  private readonly log = new Logger(MeetingAccountsService.name);
  private readonly cipher: TokenCipher | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly jwt: JwtService,
    @Inject(MEETING_ENDPOINTS)
    private readonly endpoints: Readonly<
      Record<ConnectableProvider, ProviderEndpoints>
    >,
  ) {
    const secret = this.config.get('MEETING_TOKEN_SECRET', { infer: true });
    // Null rather than a fallback key. A default would mean credentials
    // "encrypted" with a value that is in the source, which is worse than
    // refusing to store them at all — and the env check already stops a boot
    // that has providers configured without one.
    this.cipher = secret ? new TokenCipher(secret) : null;
  }

  /** The providers this deployment can offer at all. */
  availableProviders(): ConnectableProvider[] {
    return (Object.keys(OAUTH_PROVIDERS) as ConnectableProvider[]).filter(
      (provider) => this.credentialsFor(provider) !== null,
    );
  }

  /** What this tutor has connected. */
  async connectionsFor(user: User): Promise<MeetingConnection[]> {
    const accounts = await this.prisma.meetingAccount.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'asc' },
    });

    return accounts
      .filter((account) => isConnectable(account.provider))
      .map((account) => ({
        provider: account.provider as ConnectableProvider,
        accountLabel: account.accountLabel,
        connectedAt: account.createdAt.toISOString(),
      }));
  }

  /**
   * The URL to open in a browser to connect a provider.
   *
   * The caller is authenticated here and will not be at the callback — a browser
   * redirect carries no `Authorization` header — so who is connecting travels in
   * a signed, short-lived `state`. Signed rather than random-and-stored because
   * the alternative is a table of pending connections to expire; signed with the
   * app's own secret means a forged state is simply not accepted.
   */
  authorizeUrlFor(user: User, provider: MeetingProvider): string {
    const credentials = this.requireCredentials(provider);
    const config = OAUTH_PROVIDERS[credentials.provider];

    const url = new URL(this.endpoints[credentials.provider].authorize);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', credentials.clientId);
    url.searchParams.set(
      'redirect_uri',
      this.redirectUri(credentials.provider),
    );
    url.searchParams.set('scope', config.scope);
    url.searchParams.set(
      'state',
      this.jwt.sign(
        {
          sub: user.id,
          provider: credentials.provider,
          use: 'meeting-connect',
        },
        { expiresIn: STATE_TTL_SECONDS },
      ),
    );

    for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }

  /**
   * Completes a connection: verifies the state, exchanges the code, stores what
   * comes back.
   *
   * Returns nothing the browser should see. The caller redirects into the app,
   * because a person who has just approved something should end up back where
   * they started rather than on a page from an API.
   */
  async completeConnection(
    provider: MeetingProvider,
    code: string,
    state: string,
  ): Promise<void> {
    const credentials = this.requireCredentials(provider);

    let userId: string;
    try {
      const claims = this.jwt.verify<{
        sub?: string;
        provider?: string;
        use?: string;
      }>(state);

      // The `use` claim matters: without it an ordinary access token would be
      // accepted here, and this endpoint is reachable without one.
      if (
        claims.use !== 'meeting-connect' ||
        claims.provider !== credentials.provider ||
        !claims.sub
      ) {
        throw new Error('wrong state');
      }
      userId = claims.sub;
    } catch {
      throw new BadRequestException('That connection request has expired');
    }

    const tokens = await this.exchange(credentials.provider, {
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.redirectUri(credentials.provider),
    });

    if (tokens.refreshToken === null) {
      // Without one, the connection would work for an hour and then quietly
      // stop. Said now, while somebody is watching.
      throw new BadRequestException(
        'That provider did not grant lasting access. Try connecting again.',
      );
    }

    const label = await OAUTH_PROVIDERS[credentials.provider]
      .describeAccount({
        api: this.endpoints[credentials.provider].api,
        accessToken: tokens.accessToken,
      })
      .catch(() => null);

    const stored = {
      refreshToken: this.encrypt(tokens.refreshToken),
      accessToken: this.encrypt(tokens.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      accountLabel: label,
    };

    await this.prisma.meetingAccount.upsert({
      where: {
        userId_provider: { userId, provider: credentials.provider },
      },
      create: { userId, provider: credentials.provider, ...stored },
      update: stored,
    });
  }

  async disconnect(user: User, provider: MeetingProvider): Promise<void> {
    const removed = await this.prisma.meetingAccount.deleteMany({
      where: { userId: user.id, provider },
    });

    if (removed.count === 0) {
      throw new NotFoundException('That provider is not connected');
    }
  }

  /**
   * A room for one lesson, or null if this tutor has no usable connection.
   *
   * Null rather than an exception, and that is the important decision here:
   * booking a lesson must not fail because Zoom is down or a token was revoked
   * somewhere else. The caller falls back to whatever the settings offer and the
   * lesson is still booked.
   */
  async createRoom(
    user: User,
    provider: MeetingProvider,
    lesson: { topic: string; startsAt: Date; durationMinutes: number },
  ): Promise<string | null> {
    if (!isConnectable(provider)) return null;

    const account = await this.prisma.meetingAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider } },
    });
    if (!account) return null;

    const accessToken = await this.accessTokenFor(account);
    if (accessToken === null) return null;

    try {
      return await OAUTH_PROVIDERS[provider].createRoom({
        api: this.endpoints[provider].api,
        accessToken,
        ...lesson,
      });
    } catch (error) {
      this.log.error(
        `Could not create a ${provider} room for ${user.id}: ${describe(error)}`,
      );
      return null;
    }
  }

  /**
   * A usable access token, refreshing if the cached one has run out.
   *
   * Returns null when the connection is beyond saving, and **deletes it** in
   * that case: a refresh token the provider has rejected will never work again,
   * and leaving the row means the app keeps saying "connected" while every
   * lesson silently gets no link. Removing it makes the settings screen tell the
   * truth and gives the tutor something to do about it.
   */
  private async accessTokenFor(
    account: MeetingAccount,
  ): Promise<string | null> {
    const provider = account.provider as ConnectableProvider;

    const cached =
      account.accessToken === null ? null : this.decrypt(account.accessToken);
    if (
      cached !== null &&
      account.accessTokenExpiresAt !== null &&
      account.accessTokenExpiresAt.getTime() - EXPIRY_SLACK_MS > Date.now()
    ) {
      return cached;
    }

    const refreshToken = this.decrypt(account.refreshToken);
    if (refreshToken === null) {
      // Encrypted with a key this build does not have. Nothing can be done with
      // it, and keeping it would leave the same failure every time.
      this.log.warn(
        `Dropping a ${provider} connection whose credential could not be read`,
      );
      await this.forget(account);
      return null;
    }

    let tokens: TokenSet;
    try {
      tokens = await this.exchange(provider, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
    } catch (error) {
      this.log.error(
        `Refreshing ${provider} for ${account.userId} failed: ${describe(error)}`,
      );
      await this.forget(account);
      return null;
    }

    await this.prisma.meetingAccount.update({
      where: { id: account.id },
      data: {
        // Written back whatever came out. Zoom rotates and invalidates the old
        // one; Google returns nothing and the old one stays valid. Handling only
        // one of those leaves the other broken on the second lesson.
        refreshToken:
          tokens.refreshToken === null
            ? account.refreshToken
            : this.encrypt(tokens.refreshToken),
        accessToken: this.encrypt(tokens.accessToken),
        accessTokenExpiresAt: new Date(Date.now() + tokens.expiresIn * 1000),
      },
    });

    return tokens.accessToken;
  }

  private forget(account: MeetingAccount): Promise<unknown> {
    return this.prisma.meetingAccount
      .delete({ where: { id: account.id } })
      .catch(() => null);
  }

  /** One shape for both exchanges: they differ only in the grant. */
  private async exchange(
    provider: ConnectableProvider,
    form: Record<string, string>,
  ): Promise<TokenSet> {
    const credentials = this.requireCredentials(provider);
    const config = OAUTH_PROVIDERS[provider];

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    const body = new URLSearchParams(form);

    if (config.basicAuth) {
      const pair = `${credentials.clientId}:${credentials.clientSecret}`;
      headers.Authorization = `Basic ${Buffer.from(pair).toString('base64')}`;
    } else {
      body.set('client_id', credentials.clientId);
      body.set('client_secret', credentials.clientSecret);
    }

    const response = await fetch(this.endpoints[provider].token, {
      method: 'POST',
      headers,
      body: body.toString(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `token endpoint said ${response.status}: ${text.slice(0, 300)}`,
      );
    }

    const payload = (await response.json()) as {
      access_token?: unknown;
      refresh_token?: unknown;
      expires_in?: unknown;
    };

    if (typeof payload.access_token !== 'string') {
      throw new Error('token endpoint returned no access_token');
    }

    return {
      accessToken: payload.access_token,
      refreshToken:
        typeof payload.refresh_token === 'string'
          ? payload.refresh_token
          : null,
      // An hour is both providers' default, and the fallback only matters for a
      // response that omitted the field.
      expiresIn:
        typeof payload.expires_in === 'number' ? payload.expires_in : 3600,
    };
  }

  private redirectUri(provider: ConnectableProvider): string {
    const base = this.config.get('PUBLIC_API_URL', { infer: true });
    if (!base) {
      throw new BadRequestException('Connecting a provider is not configured');
    }

    return `${base.replace(/\/$/, '')}/api/meetings/callback/${provider}`;
  }

  private credentialsFor(provider: MeetingProvider): {
    provider: ConnectableProvider;
    clientId: string;
    clientSecret: string;
  } | null {
    if (!isConnectable(provider)) return null;

    const prefix = provider === MeetingProvider.ZOOM ? 'ZOOM' : 'GOOGLE';
    const clientId = this.config.get(`${prefix}_CLIENT_ID` as never, {
      infer: true,
    });
    const clientSecret = this.config.get(`${prefix}_CLIENT_SECRET` as never, {
      infer: true,
    });

    return clientId && clientSecret
      ? { provider, clientId, clientSecret }
      : null;
  }

  private requireCredentials(provider: MeetingProvider) {
    const credentials = this.credentialsFor(provider);
    if (credentials === null || this.cipher === null) {
      throw new BadRequestException(
        'That provider cannot be connected on this server',
      );
    }

    return credentials;
  }

  private encrypt(value: string): string {
    if (this.cipher === null) {
      throw new BadRequestException('Storing credentials is not configured');
    }
    return this.cipher.encrypt(value);
  }

  private decrypt(value: string): string | null {
    return this.cipher === null ? null : this.cipher.decrypt(value);
  }
}

/** Errors reach the log as text; anything else would print `[object Object]`. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
