import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MeetingProvider } from '../../generated/prisma/enums';
import type {
  ConnectableProvider,
  ProviderEndpoints,
} from '../../src/meetings/oauth-providers';

/**
 * A stand-in for Zoom and Google that speaks their protocol.
 *
 * Neither can be exercised for real without somebody's account and a browser
 * consenting, so without this the integration would ship on the strength of
 * having been read carefully. What this proves is everything up to their servers:
 * that the exchange sends the grant type and the redirect they document, that
 * Zoom's credentials go in a Basic header and Google's in the body, that a
 * rotated refresh token is written back, that a revoked one drops the
 * connection, that a cached token is not refreshed needlessly, and that a
 * provider having a bad minute does not stop a lesson being booked.
 *
 * What it cannot prove is that their real responses match their documentation.
 * That is what `npm run meetings:preflight` is for, once credentials exist.
 */

export type RecordedRequest = {
  method: string;
  path: string;
  authorization: string | null;
  contentType: string | null;
  /** Parsed as form or JSON, whichever the request claimed to be. */
  body: Record<string, unknown>;
};

/** What the fake should do next. Every test sets only what it cares about. */
export type FakeBehaviour = {
  /** Emitted as `refresh_token` on the next exchange. Null omits the field. */
  nextRefreshToken: string | null;
  /** Emitted as `access_token`. */
  nextAccessToken: string;
  /** Seconds. A small number makes the cached token look already expired. */
  expiresIn: number;
  /** Answer the token endpoint with 400 `invalid_grant`, as a revoked one does. */
  refuseRefresh: boolean;
  /** Answer the room endpoint with 500. */
  refuseRoom: boolean;
  /** Return a room without the URL field, which a broken provider might. */
  roomWithoutUrl: boolean;
  /** The join URL handed back. */
  roomUrl: string;
  /** The account label Zoom reports. */
  accountEmail: string | null;
};

export type FakeProvider = {
  /** Endpoints to hand to the application under test. */
  endpoints: Readonly<Record<ConnectableProvider, ProviderEndpoints>>;
  behaviour: FakeBehaviour;
  /** Every request the application made, oldest first. */
  requests: RecordedRequest[];
  /** Requests whose path ends in `/token`. */
  tokenRequests: RecordedRequest[];
  reset(): void;
  close(): Promise<void>;
};

export async function startFakeProvider(): Promise<FakeProvider> {
  const requests: RecordedRequest[] = [];

  const behaviour: FakeBehaviour = {
    nextRefreshToken: 'refresh-1',
    nextAccessToken: 'access-1',
    expiresIn: 3600,
    refuseRefresh: false,
    refuseRoom: false,
    roomWithoutUrl: false,
    roomUrl: 'https://example.test/join/room-1',
    accountEmail: 'tutor@example.test',
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const contentType = request.headers['content-type'] ?? null;
      const path = request.url ?? '';

      requests.push({
        method: request.method ?? 'GET',
        path,
        authorization: request.headers.authorization ?? null,
        contentType,
        body: parseBody(raw, contentType),
      });

      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify(payload));
      };

      // --- the token endpoint, shared by both providers ---
      if (path.endsWith('/token')) {
        const { grant_type: grant } = parseBody(raw, contentType) as {
          grant_type?: string;
        };

        if (behaviour.refuseRefresh && grant === 'refresh_token') {
          // What both providers answer for a token the user has revoked, or one
          // that has already been rotated away.
          return send(400, {
            error: 'invalid_grant',
            error_description: 'Invalid refresh token',
          });
        }

        return send(200, {
          access_token: behaviour.nextAccessToken,
          ...(behaviour.nextRefreshToken === null
            ? {}
            : { refresh_token: behaviour.nextRefreshToken }),
          expires_in: behaviour.expiresIn,
          token_type: 'bearer',
        });
      }

      // --- Zoom: who am I ---
      if (path.endsWith('/v2/users/me')) {
        return send(200, { email: behaviour.accountEmail });
      }

      // --- creating a room ---
      const isRoom =
        path.endsWith('/v2/users/me/meetings') || path.endsWith('/v2/spaces');

      if (isRoom) {
        if (behaviour.refuseRoom) {
          return send(500, { message: 'Provider is having a bad minute' });
        }
        if (behaviour.roomWithoutUrl) {
          return send(201, { id: 'made-but-unusable' });
        }

        // Zoom calls it `join_url`, Google `meetingUri`. Both are sent so one
        // fake can answer for either, and the code under test still has to read
        // the right one for the provider it is talking to.
        return send(201, {
          id: 'room-1',
          join_url: behaviour.roomUrl,
          meetingUri: behaviour.roomUrl,
        });
      }

      send(404, { message: `Nothing at ${path}` });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    endpoints: {
      [MeetingProvider.ZOOM]: {
        authorize: `${base}/zoom/authorize`,
        token: `${base}/zoom/token`,
        api: `${base}/zoom`,
      },
      [MeetingProvider.GOOGLE_MEET]: {
        authorize: `${base}/google/authorize`,
        token: `${base}/google/token`,
        api: `${base}/google`,
      },
    },
    behaviour,
    get requests() {
      return requests;
    },
    get tokenRequests() {
      return requests.filter((entry) => entry.path.endsWith('/token'));
    },
    reset() {
      requests.length = 0;
      Object.assign(behaviour, {
        nextRefreshToken: 'refresh-1',
        nextAccessToken: 'access-1',
        expiresIn: 3600,
        refuseRefresh: false,
        refuseRoom: false,
        roomWithoutUrl: false,
        roomUrl: 'https://example.test/join/room-1',
        accountEmail: 'tutor@example.test',
      } satisfies FakeBehaviour);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  } satisfies FakeProvider & { requests: RecordedRequest[] };
}

/** Whichever encoding the request claimed. Neither provider uses anything else. */
function parseBody(
  raw: string,
  contentType: string | null,
): Record<string, unknown> {
  if (raw === '') return {};

  if (contentType?.includes('application/json')) {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  return Object.fromEntries(new URLSearchParams(raw));
}
