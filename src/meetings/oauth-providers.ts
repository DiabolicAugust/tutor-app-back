import { MeetingProvider } from '../../generated/prisma/enums';

/**
 * The providers a tutor can connect an account to, and what each one needs.
 *
 * Connecting is what makes "a room per lesson" possible for Zoom and Google:
 * neither will create a meeting for a person who has not consented, so until
 * they have, the best either can offer is the room the tutor already owns.
 * Jitsi is absent from this table on purpose — it needs no account, which is why
 * it works with nothing configured.
 *
 * Everything provider-specific lives here: where the browser goes, where tokens
 * are exchanged, how the credentials are presented, and how a room is made.
 */

/** The subset of providers that can be connected. */
export type ConnectableProvider =
  typeof MeetingProvider.ZOOM | typeof MeetingProvider.GOOGLE_MEET;

export const CONNECTABLE_PROVIDERS: readonly ConnectableProvider[] = [
  MeetingProvider.ZOOM,
  MeetingProvider.GOOGLE_MEET,
];

export function isConnectable(
  provider: MeetingProvider,
): provider is ConnectableProvider {
  return (CONNECTABLE_PROVIDERS as readonly MeetingProvider[]).includes(
    provider,
  );
}

/**
 * Where a provider lives.
 *
 * Separated from the behaviour so tests can point the whole exchange at a server
 * of their own. That is not a nicety: neither Zoom nor Google can be exercised
 * without somebody's real account, so a stand-in that speaks their protocol is
 * the only way to prove that what this sends is what they documented — the
 * grant types, the Basic header, the JSON bodies, and what happens when a
 * refresh token is rotated or revoked.
 */
export type ProviderEndpoints = {
  authorize: string;
  token: string;
  /** Base for the provider's own API, without a trailing slash. */
  api: string;
};

export const DEFAULT_ENDPOINTS: Readonly<
  Record<ConnectableProvider, ProviderEndpoints>
> = {
  [MeetingProvider.ZOOM]: {
    authorize: 'https://zoom.us/oauth/authorize',
    token: 'https://zoom.us/oauth/token',
    api: 'https://api.zoom.us',
  },
  [MeetingProvider.GOOGLE_MEET]: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    api: 'https://meet.googleapis.com',
  },
};

/** What a provider hands back when a code or a refresh token is exchanged. */
export type TokenSet = {
  accessToken: string;
  /**
   * The new refresh token, when the provider issued one.
   *
   * Zoom rotates on every refresh and invalidates the previous token, so this is
   * not an optimisation to skip — a refresh whose result is not written back
   * leaves the connection dead the next time it is used. Google does not rotate
   * and leaves this null, which is why the caller keeps the old one rather than
   * clearing it.
   */
  refreshToken: string | null;
  /** Seconds from now. */
  expiresIn: number;
};

export type RoomRequest = {
  api: string;
  accessToken: string;
  topic: string;
  startsAt: Date;
  durationMinutes: number;
};

export type OAuthProvider = {
  /**
   * The narrowest scope that allows creating a meeting, and nothing else. Read
   * access to somebody's calendar or their recordings is not needed to book a
   * room, and asking for it is both a worse consent screen and a bigger loss if
   * the token ever leaks.
   */
  scope: string;
  /** Extra parameters this provider needs on the authorize URL. */
  authorizeParams?: Readonly<Record<string, string>>;
  /**
   * Whether the client id and secret go in an `Authorization: Basic` header
   * rather than the form body. Zoom requires the header; Google accepts either.
   */
  basicAuth: boolean;
  /** Creating a room, with an access token minted for the tutor. */
  createRoom: (request: RoomRequest) => Promise<string>;
  /** Who the tutor connected as, for the settings screen. Null if unavailable. */
  describeAccount: (options: {
    api: string;
    accessToken: string;
  }) => Promise<string | null>;
};

/** Anything that is not 2xx is a failure worth the response body in the log. */
async function jsonOrThrow(response: Response, what: string): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `${what} failed with ${response.status}: ${body.slice(0, 300)}`,
    );
  }

  return response.json();
}

export const OAUTH_PROVIDERS: Readonly<
  Record<ConnectableProvider, OAuthProvider>
> = {
  [MeetingProvider.ZOOM]: {
    // Granular scope. Zoom's older `meeting:write` still works for apps created
    // before granular scopes existed; new apps are given this one.
    scope: 'meeting:write:meeting',
    basicAuth: true,

    async createRoom({ api, accessToken, topic, startsAt, durationMinutes }) {
      const body = await jsonOrThrow(
        await fetch(`${api}/v2/users/me/meetings`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            topic,
            // A scheduled meeting rather than an instant one, so the link works
            // at the hour it was booked for rather than only right now.
            type: 2,
            start_time: startsAt.toISOString(),
            duration: durationMinutes,
            timezone: 'UTC',
            settings: {
              // Students join without waiting for the tutor to arrive first.
              join_before_host: true,
              waiting_room: false,
            },
          }),
        }),
        'Creating a Zoom meeting',
      );

      const url = (body as { join_url?: unknown }).join_url;
      if (typeof url !== 'string') {
        throw new Error('Zoom created a meeting without a join_url');
      }

      return url;
    },

    async describeAccount({ api, accessToken }) {
      const body = await jsonOrThrow(
        await fetch(`${api}/v2/users/me`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        }),
        'Reading the Zoom account',
      );

      const email = (body as { email?: unknown }).email;
      return typeof email === 'string' ? email : null;
    },
  },

  [MeetingProvider.GOOGLE_MEET]: {
    scope: 'https://www.googleapis.com/auth/meetings.space.created',
    authorizeParams: {
      // Without both of these Google issues no refresh token at all, and the
      // connection dies an hour after it is made. `prompt=consent` is needed
      // every time rather than only the first: a second connection without it
      // comes back with an access token and nothing to renew it with.
      access_type: 'offline',
      prompt: 'consent',
    },
    basicAuth: false,

    async createRoom({ api, accessToken }) {
      // A Meet space carries no topic, start time or duration — it is a room,
      // not an appointment. The rest of the request is ignored here rather than
      // being quietly translated into something it is not.
      const body = await jsonOrThrow(
        await fetch(`${api}/v2/spaces`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }),
        'Creating a Meet space',
      );

      const url = (body as { meetingUri?: unknown }).meetingUri;
      if (typeof url !== 'string') {
        throw new Error('Google created a space without a meetingUri');
      }

      return url;
    },

    describeAccount() {
      // The scope granted here does not include the userinfo endpoints, and
      // asking for one that does would widen the consent screen for a label.
      return Promise.resolve(null);
    },
  },
};
