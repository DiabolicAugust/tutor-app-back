import request from 'supertest';

import { DevicePlatform, UserRole } from '../generated/prisma/enums';
import { PushService, type PushMessage } from '../src/push/push.service';
import { authHeader, makeSchool, makeUser } from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

/** Collects what would have been sent, and can pretend a token has died. */
class RecordingPushService {
  sent: PushMessage[][] = [];
  retire: string[] = [];

  send(messages: readonly PushMessage[]) {
    this.sent.push([...messages]);
    return Promise.resolve({ retiredTokens: this.retire });
  }

  get lastBatch(): PushMessage[] {
    return this.sent[this.sent.length - 1] ?? [];
  }
}

describe('Push notifications', () => {
  let test: TestApp;
  let push: RecordingPushService;

  beforeAll(async () => {
    push = new RecordingPushService();
    // The one collaborator that talks to somebody else's servers, so the one
    // worth replacing. Everything below it — tokens, batching, retirement — is
    // the real code.
    test = await createTestApp((builder) =>
      builder.overrideProvider(PushService).useValue(push),
    );
  });

  afterAll(async () => {
    await test.close();
  });

  beforeEach(async () => {
    await test.reset();
    push.sent = [];
    push.retire = [];
  });

  const registerDevice = (header: Record<string, string>, token: string) =>
    request(test.server)
      .post('/api/users/me/devices')
      .set(header)
      .send({ token, platform: DevicePlatform.ANDROID });

  describe('registering a device', () => {
    it('records it against the caller', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await registerDevice(
        await authHeader(test, tutor),
        'ExponentPushToken[aaa]',
      ).expect(204);

      const stored = await test.prisma.pushToken.findFirstOrThrow();
      expect(stored).toMatchObject({
        token: 'ExponentPushToken[aaa]',
        platform: DevicePlatform.ANDROID,
        userId: tutor.id,
      });
    });

    it('is idempotent, so an app that registers on every launch adds one row', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);

      await registerDevice(header, 'ExponentPushToken[aaa]').expect(204);
      await registerDevice(header, 'ExponentPushToken[aaa]').expect(204);

      expect(await test.prisma.pushToken.count()).toBe(1);
    });

    it('moves the device to whoever signed in last', async () => {
      const school = await makeSchool(test);
      const first = await makeUser(test, { school });
      const second = await makeUser(test, { school });

      await registerDevice(
        await authHeader(test, first),
        'ExponentPushToken[shared]',
      ).expect(204);
      await registerDevice(
        await authHeader(test, second),
        'ExponentPushToken[shared]',
      ).expect(204);

      // One phone, one owner. A second row would send the school's
      // announcements to whoever used the device first, forever.
      expect(await test.prisma.pushToken.count()).toBe(1);
      const stored = await test.prisma.pushToken.findFirstOrThrow();
      expect(stored.userId).toBe(second.id);
    });

    it('forgets it on sign-out', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);

      await registerDevice(header, 'ExponentPushToken[aaa]').expect(204);

      await request(test.server)
        .delete('/api/users/me/devices')
        .set(header)
        .send({
          token: 'ExponentPushToken[aaa]',
          platform: DevicePlatform.ANDROID,
        })
        .expect(204);

      expect(await test.prisma.pushToken.count()).toBe(0);
    });

    it("cannot forget somebody else's device", async () => {
      const school = await makeSchool(test);
      const owner = await makeUser(test, { school });
      const stranger = await makeUser(test, { school });

      await registerDevice(
        await authHeader(test, owner),
        'ExponentPushToken[aaa]',
      ).expect(204);

      await request(test.server)
        .delete('/api/users/me/devices')
        .set(await authHeader(test, stranger))
        .send({
          token: 'ExponentPushToken[aaa]',
          platform: DevicePlatform.ANDROID,
        })
        .expect(204);

      expect(await test.prisma.pushToken.count()).toBe(1);
    });

    it('requires a signed-in caller', async () => {
      await request(test.server)
        .post('/api/users/me/devices')
        .send({
          token: 'ExponentPushToken[aaa]',
          platform: DevicePlatform.ANDROID,
        })
        .expect(401);
    });

    it('goes when the account does', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await registerDevice(
        await authHeader(test, tutor),
        'ExponentPushToken[aaa]',
      ).expect(204);
      await test.prisma.user.delete({ where: { id: tutor.id } });

      expect(await test.prisma.pushToken.count()).toBe(0);
    });
  });

  describe('an announcement', () => {
    /** An admin, a tutor with two devices, and a tutor with none. */
    const school = async () => {
      const s = await makeSchool(test, { name: 'Fox Academy' });
      const admin = await makeUser(test, {
        school: s,
        role: UserRole.ADMIN,
        name: 'Olha',
      });
      const connected = await makeUser(test, { school: s });
      const offline = await makeUser(test, { school: s });

      const header = await authHeader(test, connected);
      await registerDevice(header, 'ExponentPushToken[phone]').expect(204);
      await registerDevice(header, 'ExponentPushToken[tablet]').expect(204);

      return {
        s,
        admin,
        connected,
        offline,
        adminHeader: await authHeader(test, admin),
      };
    };

    /** Not `async`: the caller needs supertest's chainable object, not a promise. */
    const announce = (header: Record<string, string>, text: string) =>
      request(test.server)
        .post('/api/notifications/announcements')
        .set(header)
        .send({ text });

    it('reaches every device its recipients have registered', async () => {
      const { adminHeader } = await school();

      const response = await announce(
        adminHeader,
        'Parents evening moves to Friday.',
      ).expect(201);

      expect(response.body).toEqual({ recipients: 3, devices: 2 });
      expect(push.lastBatch.map((message) => message.to).sort()).toEqual([
        'ExponentPushToken[phone]',
        'ExponentPushToken[tablet]',
      ]);
    });

    it('carries the school name and the words somebody wrote', async () => {
      const { adminHeader } = await school();

      await announce(
        adminHeader,
        '  Parents evening moves to Friday.  ',
      ).expect(201);

      // Untranslated on purpose: the OS renders this while the app is not
      // running, so the server cannot ask which language the reader wants — and
      // the announcement is already in the language its author chose.
      expect(push.lastBatch[0]).toMatchObject({
        title: 'Fox Academy',
        body: 'Parents evening moves to Friday.',
        channelId: 'announcements',
      });
    });

    it('carries enough for the app to open the right screen', async () => {
      const { adminHeader } = await school();

      await announce(adminHeader, 'Something worth reading.').expect(201);

      expect(push.lastBatch[0].data).toEqual({ kind: 'ADMIN_ANNOUNCEMENT' });
    });

    it('never pushes to another school', async () => {
      const { adminHeader } = await school();
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });
      await registerDevice(
        await authHeader(test, stranger),
        'ExponentPushToken[else]',
      ).expect(204);

      await announce(adminHeader, 'Internal news only.').expect(201);

      expect(push.lastBatch.map((message) => message.to)).not.toContain(
        'ExponentPushToken[else]',
      );
    });

    it('drops a token the push service says is dead', async () => {
      const { adminHeader } = await school();
      push.retire = ['ExponentPushToken[tablet]'];

      const response = await announce(
        adminHeader,
        'The tablet has been wiped.',
      ).expect(201);

      // Reported as one delivery, and the dead row is gone: otherwise the table
      // keeps every token the app ever issued and each reinstall adds another.
      expect(response.body).toEqual({ recipients: 3, devices: 1 });
      const remaining = await test.prisma.pushToken.findMany();
      expect(remaining.map((row) => row.token)).toEqual([
        'ExponentPushToken[phone]',
      ]);
    });

    it('sends nothing when nobody has a device', async () => {
      const s = await makeSchool(test);
      const admin = await makeUser(test, { school: s, role: UserRole.ADMIN });

      const response = await announce(
        await authHeader(test, admin),
        'Nobody is listening yet.',
      ).expect(201);

      expect(response.body).toEqual({ recipients: 1, devices: 0 });
      expect(push.sent).toEqual([]);
    });

    it('is still stored when the push service is unreachable', async () => {
      const { adminHeader } = await school();
      const failing = jest
        .spyOn(push, 'send')
        .mockRejectedValue(new Error('Push service unreachable'));

      try {
        // The feed is where an announcement lives; a push is a tap on the
        // shoulder about it. Failing the request would trade a real success for
        // a fake failure.
        const response = await announce(
          adminHeader,
          'The network is down.',
        ).expect(201);
        expect(response.body).toEqual({ recipients: 3, devices: 0 });
      } finally {
        failing.mockRestore();
      }

      expect(await test.prisma.notification.count()).toBe(3);
    });
  });
});
