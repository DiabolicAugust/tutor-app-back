import request from 'supertest';

import type { User } from '../generated/prisma/client';
import { MeetingProvider } from '../generated/prisma/enums';
import { MEETING_ENDPOINTS } from '../src/meetings/meeting-accounts.service';
import { TokenCipher } from '../src/meetings/token-cipher';
import {
  authHeader,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { startFakeProvider, type FakeProvider } from './support/fake-provider';
import { createTestApp, type TestApp } from './support/test-app';

/**
 * Connecting Zoom and Google, and the rooms that follow.
 *
 * Driven against a stand-in that speaks their protocol — see `fake-provider.ts`
 * for what that can and cannot prove. In short: everything on this side of their
 * servers, which is where all the mistakes we can make live.
 */

const API_BASE = 'https://api.example.test';
const TOKEN_SECRET = 'a-test-secret-that-is-long-enough-to-pass';
const APP_URL = 'foxacademy://settings';

const at = (dayOffset: number, hour = 10): Date => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
};

describe('Meeting providers', () => {
  let test: TestApp;
  let fake: FakeProvider;
  let cipher: TokenCipher;
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    fake = await startFakeProvider();
    cipher = new TokenCipher(TOKEN_SECRET);

    // The application reads these once, at boot. Set before it is built and put
    // back afterwards, so no other spec inherits a configured provider.
    for (const [key, value] of Object.entries({
      ZOOM_CLIENT_ID: 'zoom-client',
      ZOOM_CLIENT_SECRET: 'zoom-secret',
      GOOGLE_CLIENT_ID: 'google-client',
      GOOGLE_CLIENT_SECRET: 'google-secret',
      PUBLIC_API_URL: API_BASE,
      MEETING_CONNECTED_URL: APP_URL,
      MEETING_TOKEN_SECRET: TOKEN_SECRET,
    })) {
      previousEnv[key] = process.env[key];
      process.env[key] = value;
    }

    test = await createTestApp((builder) =>
      builder.overrideProvider(MEETING_ENDPOINTS).useValue(fake.endpoints),
    );
  });

  afterAll(async () => {
    await test.close();
    await fake.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(async () => {
    await test.reset();
    fake.reset();
  });

  /** The authorize URL a tutor would be sent to, as the app asks for it. */
  async function startConnecting(tutor: User, provider: MeetingProvider) {
    const { body } = await request(test.server)
      .post(`/api/meetings/connect/${provider}`)
      .set(await authHeader(test, tutor))
      .expect(201);

    return new URL(body.authorizeUrl as string);
  }

  /** Connects a provider the way the browser would, and returns the redirect. */
  async function connect(tutor: User, provider: MeetingProvider) {
    const state = (await startConnecting(tutor, provider)).searchParams.get(
      'state',
    )!;

    return request(test.server)
      .get(`/api/meetings/callback/${provider}`)
      .query({ code: 'the-code', state })
      .expect(302);
  }

  describe('starting a connection', () => {
    it('sends the browser everything the provider needs', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const url = await startConnecting(tutor, MeetingProvider.ZOOM);

      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('client_id')).toBe('zoom-client');
      // Must match what is registered with the provider exactly, so it is built
      // from configuration rather than from the request's own Host header.
      expect(url.searchParams.get('redirect_uri')).toBe(
        `${API_BASE}/api/meetings/callback/ZOOM`,
      );
      expect(url.searchParams.get('scope')).toBe('meeting:write:meeting');
      expect(url.searchParams.get('state')).toBeTruthy();
    });

    it('asks Google for lasting access, which it does not give unasked', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const url = await startConnecting(tutor, MeetingProvider.GOOGLE_MEET);

      // Without both of these Google returns no refresh token at all and the
      // connection dies an hour later, with nothing to say why.
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('scope')).toBe(
        'https://www.googleapis.com/auth/meetings.space.created',
      );
    });

    it('refuses a provider that needs no account', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .post(`/api/meetings/connect/${MeetingProvider.JITSI}`)
        .set(await authHeader(test, tutor))
        .expect(400);
    });

    it('refuses a name that is not a provider', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .post('/api/meetings/connect/SKYPE')
        .set(await authHeader(test, tutor))
        .expect(400);
    });

    it('is not available without signing in', async () => {
      await request(test.server).post('/api/meetings/connect/ZOOM').expect(401);
    });
  });

  describe('completing a connection', () => {
    it('stores the credential and sends the browser back into the app', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const response = await connect(tutor, MeetingProvider.ZOOM);

      expect(response.headers.location).toBe(
        `${APP_URL}?meeting=ZOOM&status=connected`,
      );

      const account = await test.prisma.meetingAccount.findFirstOrThrow({
        where: { userId: tutor.id },
      });
      expect(account.provider).toBe(MeetingProvider.ZOOM);
      expect(account.accountLabel).toBe('tutor@example.test');
    });

    it('never writes the credential in the clear', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      fake.behaviour.nextRefreshToken = 'the-secret-refresh-token';

      await connect(tutor, MeetingProvider.ZOOM);

      const account = await test.prisma.meetingAccount.findFirstOrThrow({
        where: { userId: tutor.id },
      });

      // The column must not contain the token. A database dump of plain refresh
      // tokens is a set of working keys to other people's accounts.
      expect(account.refreshToken).not.toContain('the-secret-refresh-token');
      expect(cipher.decrypt(account.refreshToken)).toBe(
        'the-secret-refresh-token',
      );
    });

    it('exchanges the code the way each provider requires', async () => {
      const school = await makeSchool(test);
      const zoomTutor = await makeUser(test, { school });
      const googleTutor = await makeUser(test, { school });

      await connect(zoomTutor, MeetingProvider.ZOOM);
      await connect(googleTutor, MeetingProvider.GOOGLE_MEET);

      const [zoom, google] = fake.tokenRequests;

      expect(zoom.body).toMatchObject({
        grant_type: 'authorization_code',
        code: 'the-code',
        redirect_uri: `${API_BASE}/api/meetings/callback/ZOOM`,
      });
      // Zoom insists on the credentials in a Basic header and rejects them in
      // the body.
      expect(zoom.authorization).toBe(
        `Basic ${Buffer.from('zoom-client:zoom-secret').toString('base64')}`,
      );
      expect(zoom.body.client_secret).toBeUndefined();

      // Google takes them in the body, and sending a Basic header instead is the
      // kind of difference that only shows up against the real thing.
      expect(google.authorization).toBeNull();
      expect(google.body).toMatchObject({
        grant_type: 'authorization_code',
        client_id: 'google-client',
        client_secret: 'google-secret',
      });
    });

    it('refuses a connection that came back with nothing to renew', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      // What Google does when `access_type=offline` was somehow not sent: an
      // access token and no refresh token, so the connection would work for an
      // hour and then stop.
      fake.behaviour.nextRefreshToken = null;

      const response = await connect(tutor, MeetingProvider.GOOGLE_MEET);

      expect(response.headers.location).toContain('status=failed');
      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it('refuses a state it did not sign', async () => {
      const response = await request(test.server)
        .get('/api/meetings/callback/ZOOM')
        .query({ code: 'the-code', state: 'not-a-real-state' })
        .expect(302);

      expect(response.headers.location).toContain('status=failed');
      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it('refuses an ordinary access token used as a state', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);
      const token = header.Authorization.replace('Bearer ', '');

      // The callback is reachable without authentication, so a signed token of
      // any other kind must not be accepted here. That is what the `use` claim
      // is for.
      const response = await request(test.server)
        .get('/api/meetings/callback/ZOOM')
        .query({ code: 'the-code', state: token })
        .expect(302);

      expect(response.headers.location).toContain('status=failed');
      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it("refuses one provider's state on another's callback", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const state = (
        await startConnecting(tutor, MeetingProvider.ZOOM)
      ).searchParams.get('state')!;

      const response = await request(test.server)
        .get('/api/meetings/callback/GOOGLE_MEET')
        .query({ code: 'the-code', state })
        .expect(302);

      expect(response.headers.location).toContain('status=failed');
      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it('treats a cancelled consent screen as cancelled, not broken', async () => {
      const response = await request(test.server)
        .get('/api/meetings/callback/ZOOM')
        .query({ error: 'access_denied' })
        .expect(302);

      expect(response.headers.location).toContain('status=cancelled');
    });

    it('replaces a connection rather than accumulating dead ones', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await connect(tutor, MeetingProvider.ZOOM);
      fake.behaviour.nextRefreshToken = 'refresh-2';
      await connect(tutor, MeetingProvider.ZOOM);

      const accounts = await test.prisma.meetingAccount.findMany({
        where: { userId: tutor.id },
      });
      expect(accounts).toHaveLength(1);
      expect(cipher.decrypt(accounts[0].refreshToken)).toBe('refresh-2');
    });
  });

  describe('what the app is told', () => {
    it('lists what this server offers and what is connected', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await connect(tutor, MeetingProvider.ZOOM);

      const { body } = await request(test.server)
        .get('/api/meetings/connections')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.available).toEqual(
        expect.arrayContaining(['ZOOM', 'GOOGLE_MEET']),
      );
      expect(body.connected).toEqual([
        expect.objectContaining({
          provider: 'ZOOM',
          accountLabel: 'tutor@example.test',
        }),
      ]);
      // Nothing about the credential leaves the server, in any shape.
      expect(JSON.stringify(body)).not.toContain('refresh');
    });

    it("does not show a colleague's connections", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      await connect(tutor, MeetingProvider.ZOOM);

      const { body } = await request(test.server)
        .get('/api/meetings/connections')
        .set(await authHeader(test, colleague))
        .expect(200);

      expect(body.connected).toEqual([]);
    });
  });

  describe('disconnecting', () => {
    it('removes the credential', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await connect(tutor, MeetingProvider.ZOOM);

      await request(test.server)
        .delete('/api/meetings/connect/ZOOM')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it('says so when there was nothing connected', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .delete('/api/meetings/connect/ZOOM')
        .set(await authHeader(test, tutor))
        .expect(404);
    });
  });

  describe('the room a lesson gets', () => {
    /** A tutor who teaches on `provider`, with an optional fallback room. */
    async function teachingOn(
      provider: MeetingProvider,
      roomUrl: string | null = null,
    ) {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await test.prisma.user.update({
        where: { id: tutor.id },
        data: { config: { meeting: { provider, roomUrl } } },
      });

      return { school, tutor, student };
    }

    const book = async (tutor: User, student: { id: string }) =>
      (
        await request(test.server)
          .post('/api/lessons')
          .set(await authHeader(test, tutor))
          .send({
            studentId: student.id,
            startsAt: at(1).toISOString(),
            durationMinutes: 45,
          })
          .expect(201)
      ).body;

    it('comes from the connected account, per lesson', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);

      fake.behaviour.roomUrl = 'https://example.test/join/first';
      const first = await book(tutor, student);
      fake.behaviour.roomUrl = 'https://example.test/join/second';
      const second = await book(tutor, student);

      expect(first.meetingUrl).toBe('https://example.test/join/first');
      expect(second.meetingUrl).toBe('https://example.test/join/second');
      expect(first.meetingProvider).toBe('ZOOM');
    });

    it('is asked for with the details Zoom needs to schedule it', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);
      fake.reset();

      const lesson = await book(tutor, student);

      const created = fake.requests.find((entry) =>
        entry.path.endsWith('/v2/users/me/meetings'),
      )!;
      expect(created.body).toMatchObject({
        // Type 2 is a scheduled meeting. An instant one would produce a link
        // that works now and not at the hour it was booked for.
        type: 2,
        duration: 45,
        start_time: new Date(lesson.startsAt as string).toISOString(),
      });
      expect(created.authorization).toBe('Bearer access-1');
    });

    it("does not put a student's name into an account outside the school", async () => {
      const { school, tutor } = await teachingOn(MeetingProvider.ZOOM);
      const student = await makeStudent(test, {
        school,
        tutor,
        name: 'Amelia Fairchild',
      });
      await connect(tutor, MeetingProvider.ZOOM);
      fake.reset();

      await book(tutor, student);

      const created = fake.requests.find((entry) =>
        entry.path.endsWith('/v2/users/me/meetings'),
      )!;
      // These titles are visible in somebody's Zoom account, which is outside
      // the school. The subject is enough to recognise the meeting by.
      expect(JSON.stringify(created.body)).not.toContain('Amelia');
    });

    it('reads the field the provider actually returns', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.GOOGLE_MEET);
      await connect(tutor, MeetingProvider.GOOGLE_MEET);
      fake.behaviour.roomUrl = 'https://meet.example.test/abc-defg-hij';

      const lesson = await book(tutor, student);

      expect(lesson.meetingUrl).toBe('https://meet.example.test/abc-defg-hij');
      expect(lesson.meetingProvider).toBe('GOOGLE_MEET');
      expect(
        fake.requests.some((entry) => entry.path.endsWith('/v2/spaces')),
      ).toBe(true);
    });

    it('reuses a cached token rather than refreshing on every booking', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);
      fake.reset();

      await book(tutor, student);
      await book(tutor, student);

      // The token from the exchange is still valid, so nothing should have gone
      // back to the token endpoint. Two round trips per lesson is a slow booking
      // and, on a provider with rate limits, an avoidable failure.
      expect(fake.tokenRequests).toHaveLength(0);
    });

    it('refreshes an expired token and keeps the rotated one', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      // Already expired by the time it is stored.
      fake.behaviour.expiresIn = 1;
      await connect(tutor, MeetingProvider.ZOOM);

      fake.reset();
      fake.behaviour.nextRefreshToken = 'rotated-refresh';
      fake.behaviour.nextAccessToken = 'access-2';

      const lesson = await book(tutor, student);

      expect(fake.tokenRequests).toHaveLength(1);
      expect(fake.tokenRequests[0].body).toMatchObject({
        grant_type: 'refresh_token',
        refresh_token: 'refresh-1',
      });
      expect(lesson.meetingUrl).toBeTruthy();

      // Zoom invalidates the old refresh token when it issues a new one, so a
      // rotation that is not written back leaves the connection dead on the next
      // booking. This is the assertion that catches that.
      const account = await test.prisma.meetingAccount.findFirstOrThrow({
        where: { userId: tutor.id },
      });
      expect(cipher.decrypt(account.refreshToken)).toBe('rotated-refresh');
    });

    it('keeps the old refresh token when the provider issues none', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.GOOGLE_MEET);
      fake.behaviour.expiresIn = 1;
      await connect(tutor, MeetingProvider.GOOGLE_MEET);

      // Google does not rotate: a refresh returns an access token and nothing
      // else, and clearing the stored one would break the next booking.
      fake.behaviour.nextRefreshToken = null;
      await book(tutor, student);

      const account = await test.prisma.meetingAccount.findFirstOrThrow({
        where: { userId: tutor.id },
      });
      expect(cipher.decrypt(account.refreshToken)).toBe('refresh-1');
    });

    it('drops a connection the provider has revoked, and still books', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      fake.behaviour.expiresIn = 1;
      await connect(tutor, MeetingProvider.ZOOM);

      // What the token endpoint answers once somebody has revoked access in
      // their Zoom settings.
      fake.behaviour.refuseRefresh = true;
      const lesson = await book(tutor, student);

      // The lesson exists. A commitment between two people must not fail to be
      // recorded because a third party said no.
      expect(lesson.id).toBeTruthy();
      expect(lesson.meetingUrl).toBeNull();
      // And the connection is gone, so the app stops claiming otherwise and the
      // tutor has something to act on.
      expect(await test.prisma.meetingAccount.count()).toBe(0);
    });

    it('falls back to their own room when the provider fails', async () => {
      const { tutor, student } = await teachingOn(
        MeetingProvider.ZOOM,
        'https://myschool.zoom.us/j/123',
      );
      await connect(tutor, MeetingProvider.ZOOM);
      fake.behaviour.refuseRoom = true;

      const lesson = await book(tutor, student);

      expect(lesson.meetingUrl).toBe('https://myschool.zoom.us/j/123');
      expect(lesson.meetingProvider).toBe('ZOOM');
    });

    it('books without a link when there is no room and no connection', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);

      const lesson = await book(tutor, student);

      expect(lesson.id).toBeTruthy();
      expect(lesson.meetingUrl).toBeNull();
      // Not a provider with nowhere to join: either both, or neither.
      expect(lesson.meetingProvider).toBeNull();
    });

    it('does not fail a booking when the provider returns nonsense', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);
      fake.behaviour.roomWithoutUrl = true;

      const lesson = await book(tutor, student);

      expect(lesson.id).toBeTruthy();
      expect(lesson.meetingUrl).toBeNull();
    });

    it('stops using the connection once it is disconnected', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);
      await request(test.server)
        .delete('/api/meetings/connect/ZOOM')
        .set(await authHeader(test, tutor))
        .expect(200);

      const lesson = await book(tutor, student);

      expect(lesson.meetingUrl).toBeNull();
    });

    it("never uses a colleague's connection", async () => {
      const { school, tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      const colleague = await makeUser(test, { school });
      await connect(colleague, MeetingProvider.ZOOM);

      const lesson = await book(tutor, student);

      // The room belongs to whoever authorised it. Borrowing a colleague's would
      // put a lesson in somebody else's account.
      expect(lesson.meetingUrl).toBeNull();
    });

    it('leaves a lesson alone once it is booked', async () => {
      const { tutor, student } = await teachingOn(MeetingProvider.ZOOM);
      await connect(tutor, MeetingProvider.ZOOM);
      fake.behaviour.roomUrl = 'https://example.test/join/as-booked';

      const booked = await book(tutor, student);

      // The tutor disconnects afterwards. The link already sent to a student has
      // to keep meaning what it meant.
      await request(test.server)
        .delete('/api/meetings/connect/ZOOM')
        .set(await authHeader(test, tutor))
        .expect(200);

      const { body } = await request(test.server)
        .get('/api/lessons')
        .query({ from: at(0).toISOString(), to: at(2).toISOString() })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(
        body.find((entry: { id: string }) => entry.id === booked.id).meetingUrl,
      ).toBe('https://example.test/join/as-booked');
    });
  });
});
