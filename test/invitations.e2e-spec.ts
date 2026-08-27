import request from 'supertest';

import { NotificationKind, UserRole } from '../generated/prisma/enums';
import { MailService } from '../src/mail/mail.service';
import {
  authHeader,
  makeSchool,
  makeUser,
  TEST_PASSWORD,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Invitations', () => {
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

  describe('sending one', () => {
    it('is allowed for a tutor who has been given the capability', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school, addons: ['INVITE_TUTORS'] });

      const response = await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, tutor))
        .send({ email: 'newcomer@example.test' })
        .expect(201);

      expect(response.body).toMatchObject({
        email: 'newcomer@example.test',
        status: 'pending',
      });
    });

    it('is refused for a member without it', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, tutor))
        .send({ email: 'newcomer@example.test' })
        .expect(403);
    });

    /**
     * The token used to be withheld here, and this test asserted exactly that.
     *
     * It changed on purpose. Email is the channel that fails quietly — a
     * mistyped address, an unverified sending domain, a spam folder — so the
     * admin is handed the same link to send through whatever they already use.
     * The rule that replaces "never" is narrower than "always": the link comes
     * back only as `acceptUrl`, only while the invitation is still pending, and
     * only from routes that already require the capability to invite.
     */
    it('returns the link so the admin can send it themselves', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const header = await authHeader(test, admin);

      const created = await request(test.server)
        .post('/api/invitations')
        .set(header)
        .send({ email: 'newcomer@example.test' })
        .expect(201);

      const listed = await request(test.server)
        .get('/api/invitations')
        .set(header)
        .expect(200);

      const stored = await test.prisma.invitation.findFirstOrThrow();

      expect(created.body.acceptUrl).toContain(stored.token);
      expect(listed.body[0].acceptUrl).toContain(stored.token);
      // In the link and nowhere else. A bare `token` field would invite a second
      // way of building the URL, and two spellings of it is how one ends up
      // pointing somewhere that no longer exists.
      expect(created.body.token).toBeUndefined();
    });

    it('stops returning the link once the invitation has been used', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const header = await authHeader(test, admin);

      await request(test.server)
        .post('/api/invitations')
        .set(header)
        .send({ email: 'newcomer@example.test' })
        .expect(201);

      const stored = await test.prisma.invitation.findFirstOrThrow();
      await request(test.server)
        .post(`/api/invitations/token/${stored.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      const listed = await request(test.server)
        .get('/api/invitations')
        .set(header)
        .expect(200);

      // Nothing left to send, and a dead token is only something to paste by
      // mistake. Its absence is also what the app reads to decide whether to
      // offer a share control at all.
      expect(listed.body[0].status).toBe('accepted');
      expect(listed.body[0].acceptUrl).toBeUndefined();
      expect(JSON.stringify(listed.body)).not.toContain(stored.token);
    });

    it('keeps the invitation when the email cannot be sent', async () => {
      // A provider outage, an unverified domain, a wrong key. The invitation is
      // already saved and there is another way to deliver it, so failing the
      // request would leave the admin with nothing and no explanation.
      const failing = await createTestApp((builder) =>
        builder.overrideProvider(MailService).useValue({
          sendInvitation: () =>
            Promise.reject(new Error('domain not verified')),
          sendSupportRequest: () => Promise.resolve(),
        }),
      );

      try {
        const school = await makeSchool(failing);
        const admin = await makeUser(failing, { school, role: UserRole.ADMIN });

        const created = await request(failing.server)
          .post('/api/invitations')
          .set(await authHeader(failing, admin))
          .send({ email: 'newcomer@example.test' })
          .expect(201);

        // Reported rather than hidden: the admin needs to know the email did not
        // go, precisely so they use the link instead.
        expect(created.body.mailed).toBe(false);
        expect(created.body.acceptUrl).toBeTruthy();
        expect(await failing.prisma.invitation.count()).toBe(1);
      } finally {
        await failing.close();
      }
    });

    it('refuses an address that already has an account', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      await makeUser(test, { school, email: 'already@example.test' });

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, admin))
        .send({ email: 'already@example.test' })
        .expect(409);
    });

    it('replaces the previous one when an admin resends', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const header = await authHeader(test, admin);

      await request(test.server)
        .post('/api/invitations')
        .set(header)
        .send({ email: 'newcomer@example.test' })
        .expect(201);
      const first = await test.prisma.invitation.findFirstOrThrow();

      await request(test.server)
        .post('/api/invitations')
        .set(header)
        .send({ email: 'newcomer@example.test' })
        .expect(201);

      // One row, new secret: an admin resending because the first mail was lost
      // expects it to work, and the old link must stop working.
      expect(await test.prisma.invitation.count()).toBe(1);
      const second = await test.prisma.invitation.findFirstOrThrow();
      expect(second.id).toBe(first.id);
      expect(second.token).not.toBe(first.token);
    });
  });

  describe('the link', () => {
    /** Sends one and returns its secret, the way the email would carry it. */
    const sendInvitation = async (email = 'newcomer@example.test') => {
      const school = await makeSchool(test, { name: 'Fox Academy' });
      const admin = await makeUser(test, {
        school,
        role: UserRole.ADMIN,
        name: 'Olha',
      });

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, admin))
        .send({ email })
        .expect(201);

      const invitation = await test.prisma.invitation.findFirstOrThrow();
      return { school, admin, invitation };
    };

    it('tells a stranger what they are accepting, without a token of their own', async () => {
      const { invitation } = await sendInvitation();

      // Public on purpose: holding the link *is* the authorisation, and the form
      // has to say which school before anybody types a password.
      const response = await request(test.server)
        .get(`/api/invitations/token/${invitation.token}`)
        .expect(200);

      expect(response.body).toMatchObject({
        email: 'newcomer@example.test',
        schoolName: 'Fox Academy',
        invitedByName: 'Olha',
      });
    });

    it('creates the account in that school and signs it in', async () => {
      const { school, invitation } = await sendInvitation();

      const response = await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      expect(response.body.user).toMatchObject({
        email: 'newcomer@example.test',
        role: 'tutor',
        schoolId: school.id,
      });
      expect(typeof response.body.token).toBe('string');
    });

    it('lets the new tutor sign in afterwards', async () => {
      const { invitation } = await sendInvitation();

      await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      await request(test.server)
        .post('/api/auth/sign-in')
        .send({ email: 'newcomer@example.test', password: TEST_PASSWORD })
        .expect(200);
    });

    it('tells the school that somebody has joined it', async () => {
      const { school, admin, invitation } = await sendInvitation();
      // A second person already in the school, so this proves "everybody" rather
      // than "whoever did the inviting".
      const colleague = await makeUser(test, { school, name: 'Iryna' });

      await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      const notified = await test.prisma.notification.findMany({
        where: { kind: NotificationKind.TUTOR_JOINED },
        select: { recipientId: true, data: true },
      });

      expect(notified.map((row) => row.recipientId).sort()).toEqual(
        [admin.id, colleague.id].sort(),
      );
      // The name, and only the name. What they teach is not known yet — the form
      // asks for a name and a password — so anything else here would be a guess
      // put in front of the whole school.
      expect(notified[0].data).toEqual({ personName: 'Newcomer' });
    });

    it('does not tell the newcomer about their own arrival', async () => {
      const { invitation } = await sendInvitation();

      const accepted = await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      const own = await request(test.server)
        .get('/api/notifications')
        .set({ Authorization: `Bearer ${accepted.body.token}` })
        .expect(200);

      // An announcement includes its own author, because an author needs to see
      // that their message went out. Somebody who has just filled in a
      // registration form needs no telling that they did.
      expect(own.body).toEqual([]);
    });

    it('does not reach a different school', async () => {
      const { invitation } = await sendInvitation();
      const elsewhere = await makeSchool(test, { name: 'Another' });
      const stranger = await makeUser(test, { school: elsewhere });

      await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(201);

      const theirs = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, stranger))
        .expect(200);

      expect(theirs.body).toEqual([]);
    });

    it('creates the account even when the school cannot be told', async () => {
      // The rows are a side effect of joining, not part of it. Somebody who has
      // registered is registered whether or not their colleagues heard.
      const { invitation } = await sendInvitation();
      await test.prisma.$executeRawUnsafe(
        'ALTER TABLE notifications RENAME TO notifications_hidden',
      );

      try {
        await request(test.server)
          .post(`/api/invitations/token/${invitation.token}/accept`)
          .send({ name: 'Newcomer', password: TEST_PASSWORD })
          .expect(201);
      } finally {
        await test.prisma.$executeRawUnsafe(
          'ALTER TABLE notifications_hidden RENAME TO notifications',
        );
      }

      expect(
        await test.prisma.user.count({
          where: { email: 'newcomer@example.test' },
        }),
      ).toBe(1);
    });

    it('cannot be redeemed twice', async () => {
      const { invitation } = await sendInvitation();
      const accept = () =>
        request(test.server)
          .post(`/api/invitations/token/${invitation.token}/accept`)
          .send({ name: 'Newcomer', password: TEST_PASSWORD });

      await accept().expect(201);
      await accept().expect(404);

      expect(
        await test.prisma.user.count({ where: { name: 'Newcomer' } }),
      ).toBe(1);
    });

    it('says the same thing for a link that is unknown, expired or used', async () => {
      const { invitation } = await sendInvitation();
      await test.prisma.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const expired = await request(test.server)
        .get(`/api/invitations/token/${invitation.token}`)
        .expect(404);
      const unknown = await request(test.server)
        .get('/api/invitations/token/never-existed')
        .expect(404);

      // Distinguishing them would tell a stranger which addresses were invited.
      expect(expired.body.message).toBe(unknown.body.message);
    });

    it('cannot be accepted once it has expired', async () => {
      const { invitation } = await sendInvitation();
      await test.prisma.invitation.update({
        where: { id: invitation.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(test.server)
        .post(`/api/invitations/token/${invitation.token}/accept`)
        .send({ name: 'Newcomer', password: TEST_PASSWORD })
        .expect(404);
    });
  });

  describe('revoking', () => {
    it('stops the link working', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const header = await authHeader(test, admin);

      await request(test.server)
        .post('/api/invitations')
        .set(header)
        .send({ email: 'newcomer@example.test' })
        .expect(201);
      const invitation = await test.prisma.invitation.findFirstOrThrow();

      await request(test.server)
        .delete(`/api/invitations/${invitation.id}`)
        .set(header)
        .expect(204);

      await request(test.server)
        .get(`/api/invitations/token/${invitation.token}`)
        .expect(404);
    });

    it("cannot reach another school's invitation", async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const otherAdmin = await makeUser(test, {
        school: other,
        role: UserRole.ADMIN,
      });

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, otherAdmin))
        .send({ email: 'theirs@example.test' })
        .expect(201);
      const theirs = await test.prisma.invitation.findFirstOrThrow();

      await request(test.server)
        .delete(`/api/invitations/${theirs.id}`)
        .set(await authHeader(test, admin))
        .expect(404);

      expect(await test.prisma.invitation.count()).toBe(1);
    });
  });

  /**
   * The page a shared link points at.
   *
   * It exists because a custom scheme is not a web address: pasted into a chat it
   * is not tappable, and on a device with no app it fails silently. So the link
   * that gets *sent* is https, and this is what it opens.
   */
  describe('the invitation page', () => {
    it('is served outside the api prefix, where a pasted link reads as a link', async () => {
      const page = await request(test.server)
        .get('/invite/abcdefghijklmnop')
        .expect(200);

      expect(page.headers['content-type']).toContain('text/html');
      // The handoff. Without this the page is a dead end.
      expect(page.text).toContain('foxacademy://invite/abcdefghijklmnop');
    });

    it('says nothing about the school or the invited address', async () => {
      const school = await makeSchool(test, { name: 'Fox Academy' });
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, admin))
        .send({ email: 'newcomer@example.test' })
        .expect(201);
      const invitation = await test.prisma.invitation.findFirstOrThrow();

      const page = await request(test.server)
        .get(`/invite/${invitation.token}`)
        .expect(200);

      // Anyone holding the link reaches this, including anyone it was forwarded
      // to. Whether the invitation is real is the app's question, asked once it
      // has a token to check — the page reads nothing and therefore leaks nothing.
      expect(page.text).not.toContain('newcomer@example.test');
      expect(page.text).not.toContain('Fox Academy</h1>');
    });

    it('answers the same way for a token that was never issued', async () => {
      // No lookup, so a live token and an invented one are indistinguishable from
      // outside. Otherwise the page would be a way to ask which links are real.
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, admin))
        .send({ email: 'newcomer@example.test' })
        .expect(201);
      const issued = await test.prisma.invitation.findFirstOrThrow();
      const invented = 'not-a-token-this-server-ever-made';

      const real = await request(test.server)
        .get(`/invite/${issued.token}`)
        .expect(200);
      const fake = await request(test.server)
        .get(`/invite/${invented}`)
        .expect(200);

      // Identical but for the token each one echoes back.
      expect(real.text.split(issued.token).join('T')).toBe(
        fake.text.split(invented).join('T'),
      );
    });

    it('refuses anything that is not shaped like a token', async () => {
      // The token is reflected into the page, so its alphabet is the guard. These
      // are the shapes that would matter if it were not.
      for (const bad of [
        'short',
        '..%2f..%2fetc',
        'has spaces here and more',
        'a'.repeat(200),
      ]) {
        await request(test.server).get(`/invite/${bad}`).expect(404);
      }
    });

    it('denies the page everything it does not need', async () => {
      const page = await request(test.server)
        .get('/invite/abcdefghijklmnop')
        .expect(200);

      const policy = page.headers['content-security-policy'];
      expect(policy).toContain("default-src 'none'");
      // No script at all, which is also why the reflected token has nowhere to go
      // even if the guard on its shape ever slipped.
      expect(page.text).not.toContain('<script');
    });
  });
});
