import request from 'supertest';

import { NotificationKind, UserRole } from '../generated/prisma/enums';
import { authHeader, makeSchool, makeUser } from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Notifications', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });
  beforeEach(async () => {
    await test.reset();
  });

  const notify = (recipientId: string, text = 'Hello') =>
    test.prisma.notification.create({
      data: {
        kind: NotificationKind.ADMIN_ANNOUNCEMENT,
        data: { text },
        recipientId,
      },
    });

  describe('the feed', () => {
    it("shows only the caller's own notifications", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      await notify(tutor.id, 'For me');
      await notify(colleague.id, 'For them');

      const response = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].data.text).toBe('For me');
    });

    it('shows the newest first', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const older = await notify(tutor.id, 'Older');
      await test.prisma.notification.update({
        where: { id: older.id },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      await notify(tutor.id, 'Newer');

      const response = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(
        response.body.map((n: { data: { text: string } }) => n.data.text),
      ).toEqual(['Newer', 'Older']);
    });
  });

  describe('marking read', () => {
    it('is not an error the second time', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const notification = await notify(tutor.id);
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post(`/api/notifications/${notification.id}/read`)
        .set(header)
        .expect(204);
      await request(test.server)
        .post(`/api/notifications/${notification.id}/read`)
        .set(header)
        .expect(204);

      const stored = await test.prisma.notification.findUniqueOrThrow({
        where: { id: notification.id },
      });
      expect(stored.readAt).not.toBeNull();
    });

    it("cannot mark somebody else's notification read", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await notify(colleague.id);

      await request(test.server)
        .post(`/api/notifications/${theirs.id}/read`)
        .set(await authHeader(test, tutor))
        .expect(204);

      // Silently a no-op rather than a 404: the endpoint should not confirm that
      // somebody else has a notification with this id.
      const stored = await test.prisma.notification.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(stored.readAt).toBeNull();
    });

    it("clears the whole feed at once, and only the caller's own", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      await notify(tutor.id);
      await notify(tutor.id);
      await notify(colleague.id);

      await request(test.server)
        .post('/api/notifications/read-all')
        .set(await authHeader(test, tutor))
        .expect(204);

      expect(
        await test.prisma.notification.count({ where: { readAt: null } }),
      ).toBe(1);
    });
  });

  describe('an announcement', () => {
    it('reaches everybody in the school, the author included', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, {
        school,
        role: UserRole.ADMIN,
        name: 'Olha',
      });
      const tutorA = await makeUser(test, { school });
      const tutorB = await makeUser(test, { school });

      const response = await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, admin))
        .send({ text: '  Parents evening on Friday  ' })
        .expect(201);

      // `devices` is how many phones were actually pushed to — zero here, since
      // nobody in this test has registered one.
      expect(response.body).toEqual({ recipients: 3, devices: 0 });

      for (const member of [admin, tutorA, tutorB]) {
        const theirs = await test.prisma.notification.findFirstOrThrow({
          where: { recipientId: member.id },
        });
        expect(theirs.kind).toBe(NotificationKind.ADMIN_ANNOUNCEMENT);
        // Trimmed, and carrying who said it: the app renders the name.
        expect(theirs.data).toEqual({
          text: 'Parents evening on Friday',
          personName: 'Olha',
        });
      }
    });

    it('does not reach another school', async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const stranger = await makeUser(test, { school: other });

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, admin))
        .send({ text: 'Internal news' })
        .expect(201);

      expect(
        await test.prisma.notification.count({
          where: { recipientId: stranger.id },
        }),
      ).toBe(0);
    });

    it('is allowed for a tutor granted the capability', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['BROADCAST_ANNOUNCEMENTS'],
      });

      // A school may want a senior tutor who can announce without running the
      // school.
      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, tutor))
        .send({ text: 'Room change today' })
        .expect(201);
    });

    it('is refused for a member without it', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, tutor))
        .send({ text: 'Unauthorised broadcast' })
        .expect(403);

      expect(await test.prisma.notification.count()).toBe(0);
    });

    it('rejects a message too short to mean anything', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, admin))
        .send({ text: 'hi' })
        .expect(400);
    });
  });
});
