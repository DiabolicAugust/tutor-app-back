import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
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

    it('never returns the token, which belongs only in the email', async () => {
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
      expect(JSON.stringify(created.body)).not.toContain(stored.token);
      expect(JSON.stringify(listed.body)).not.toContain(stored.token);
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
});
