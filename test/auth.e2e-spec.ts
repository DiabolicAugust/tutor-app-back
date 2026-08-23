import request from 'supertest';

import { defaultUserConfig } from '../src/users/user-config';
import { UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeSchool,
  makeUser,
  TEST_PASSWORD,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Authentication', () => {
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

  const signIn = (email: string, password: string) =>
    request(test.server).post('/api/auth/sign-in').send({ email, password });

  it('issues a session for correct credentials', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school, email: 'tutor@example.test' });

    const response = await signIn('tutor@example.test', TEST_PASSWORD).expect(
      200,
    );

    expect(response.body).toMatchObject({
      user: { id: user.id, email: 'tutor@example.test', role: 'tutor' },
    });
    expect(typeof response.body.token).toBe('string');
    expect(typeof response.body.issuedAt).toBe('string');
  });

  it('accepts an address the user typed with different casing and spacing', async () => {
    const school = await makeSchool(test);
    await makeUser(test, { school, email: 'mixed@example.test' });

    await signIn('  MIXED@Example.Test  ', TEST_PASSWORD).expect(200);
  });

  it('never says whether it was the email or the password that was wrong', async () => {
    const school = await makeSchool(test);
    await makeUser(test, { school, email: 'known@example.test' });

    const wrongPassword = await signIn(
      'known@example.test',
      'not-the-password',
    );
    const unknownEmail = await signIn('nobody@example.test', TEST_PASSWORD);

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // The same message for both: a different one would turn this endpoint into a
    // way of asking whether an address has an account.
    expect(unknownEmail.body.message).toBe(wrongPassword.body.message);
  });

  it('never returns the password hash', async () => {
    const school = await makeSchool(test);
    await makeUser(test, { school, email: 'hash@example.test' });

    const response = await signIn('hash@example.test', TEST_PASSWORD).expect(
      200,
    );

    expect(JSON.stringify(response.body)).not.toContain('$2b$');
    expect(response.body.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a password below the minimum length before touching the database', async () => {
    await signIn('someone@example.test', 'short').expect(400);
  });

  describe('the session payload', () => {
    it('carries the capabilities a tutor has been granted', async () => {
      const school = await makeSchool(test);
      const user = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, user))
        .expect(200);

      expect(response.body.addons).toEqual(['MANAGE_STUDENTS']);
    });

    it('gives an admin every capability without a single grant row', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body.addons).toEqual(
        expect.arrayContaining([
          'INVITE_TUTORS',
          'BROADCAST_ANNOUNCEMENTS',
          'MANAGE_STUDENTS',
        ]),
      );
      expect(await test.prisma.userAddon.count()).toBe(0);
    });

    it('carries a complete config even when the column holds nothing', async () => {
      const school = await makeSchool(test);
      const user = await makeUser(test, { school });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, user))
        .expect(200);

      expect(response.body.config).toEqual(defaultUserConfig);
    });

    it('falls back to defaults rather than failing on a config an older build wrote', async () => {
      const school = await makeSchool(test);
      const user = await makeUser(test, {
        school,
        config: { lessonReminderMinutes: 'half an hour', removedSetting: true },
      });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, user))
        .expect(200);

      expect(response.body.config).toEqual(defaultUserConfig);
    });
  });

  describe('protected routes', () => {
    it('reject a request with no token', async () => {
      await request(test.server).get('/api/auth/me').expect(401);
    });

    it('reject a token this server did not sign', async () => {
      await request(test.server)
        .get('/api/auth/me')
        .set({ Authorization: 'Bearer not.a.real.token' })
        .expect(401);
    });

    it('reject a token for a user who has since been deleted', async () => {
      const school = await makeSchool(test);
      const user = await makeUser(test, { school });
      const header = await authHeader(test, user);

      await test.prisma.user.delete({ where: { id: user.id } });

      await request(test.server).get('/api/auth/me').set(header).expect(401);
    });
  });
});
