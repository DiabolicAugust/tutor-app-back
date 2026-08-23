import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeSchool,
  makeUser,
  TEST_PASSWORD,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Schools', () => {
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

  const registerBody = (overrides: Record<string, unknown> = {}) => ({
    schoolName: 'Fox Academy Demo',
    adminName: 'Olha',
    adminEmail: 'olha@example.test',
    adminPassword: TEST_PASSWORD,
    ...overrides,
  });

  describe('opening a school', () => {
    it('creates the school, its first admin, and signs them in', async () => {
      const response = await request(test.server)
        .post('/api/schools/register')
        .send(registerBody())
        .expect(201);

      expect(response.body.user).toMatchObject({
        email: 'olha@example.test',
        role: 'admin',
      });
      expect(typeof response.body.token).toBe('string');

      const school = await test.prisma.school.findFirstOrThrow();
      expect(school.name).toBe('Fox Academy Demo');
      expect(school.slug).toBe('fox-academy-demo');
    });

    it('lets the new admin sign in with the password they chose', async () => {
      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody())
        .expect(201);

      await request(test.server)
        .post('/api/auth/sign-in')
        .send({ email: 'olha@example.test', password: TEST_PASSWORD })
        .expect(200);
    });

    it('gives a school whose name has no Latin letters a usable address anyway', async () => {
      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ schoolName: 'Школа Лисиця' }))
        .expect(201);

      const school = await test.prisma.school.findFirstOrThrow();
      // Not empty, and still URL-safe: a slug is what goes in a link somebody
      // has to type.
      expect(school.slug).toMatch(/^[a-z0-9-]+$/);
      expect(school.slug.length).toBeGreaterThan(0);
    });

    it('refuses an email that already has an account', async () => {
      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody())
        .expect(201);

      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ schoolName: 'Another School' }))
        .expect(409);
    });

    it('refuses an address another school already uses', async () => {
      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ slug: 'taken' }))
        .expect(201);

      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ slug: 'taken', adminEmail: 'other@example.test' }))
        .expect(409);
    });

    it('leaves no school behind when the admin cannot be created', async () => {
      const school = await makeSchool(test);
      await makeUser(test, { school, email: 'taken@example.test' });
      const schoolsBefore = await test.prisma.school.count();

      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ adminEmail: 'taken@example.test' }))
        .expect(409);

      // A school nobody can sign into would hold its slug forever.
      expect(await test.prisma.school.count()).toBe(schoolsBefore);
    });

    it('rejects a hand-written address that is not slug-shaped', async () => {
      await request(test.server)
        .post('/api/schools/register')
        .send(registerBody({ slug: 'Not A Slug' }))
        .expect(400);
    });
  });

  describe('the current school', () => {
    it('is readable by any member', async () => {
      const school = await makeSchool(test, { name: 'Readable' });
      const tutor = await makeUser(test, { school });

      const response = await request(test.server)
        .get('/api/schools/current')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toMatchObject({ id: school.id, name: 'Readable' });
    });

    it('is editable by an admin', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      await request(test.server)
        .patch('/api/schools/current')
        .set(await authHeader(test, admin))
        .send({ name: 'Renamed', timezone: 'Europe/Warsaw' })
        .expect(200);

      const updated = await test.prisma.school.findUniqueOrThrow({
        where: { id: school.id },
      });
      expect(updated).toMatchObject({
        name: 'Renamed',
        timezone: 'Europe/Warsaw',
      });
    });

    it('is not editable by a tutor, whatever capabilities they hold', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['INVITE_TUTORS', 'BROADCAST_ANNOUNCEMENTS', 'MANAGE_STUDENTS'],
      });

      // Granting permissions is the one thing that must not be delegable, so
      // this is checked by role and not by capability.
      await request(test.server)
        .patch('/api/schools/current')
        .set(await authHeader(test, tutor))
        .send({ name: 'Hijacked' })
        .expect(403);
    });
  });

  describe('the roster', () => {
    it('lists the caller first, so "my calendar" is the first filter', async () => {
      const school = await makeSchool(test);
      await makeUser(test, { school, name: 'Anna' });
      const caller = await makeUser(test, { school, name: 'Zoriana' });

      const response = await request(test.server)
        .get('/api/schools/current/tutors')
        .set(await authHeader(test, caller))
        .expect(200);

      expect(response.body[0].id).toBe(caller.id);
      expect(response.body).toHaveLength(2);
    });

    it("never includes another school, nor anyone's password hash", async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const caller = await makeUser(test, { school });
      await makeUser(test, { school: other, name: 'Stranger' });

      const response = await request(test.server)
        .get('/api/schools/current/tutors')
        .set(await authHeader(test, caller))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });

    it('lets an admin add a colleague directly', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      const response = await request(test.server)
        .post('/api/schools/current/tutors')
        .set(await authHeader(test, admin))
        .send({
          name: 'New Tutor',
          email: 'new@example.test',
          password: TEST_PASSWORD,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        email: 'new@example.test',
        role: 'TUTOR',
      });
      expect(response.body).not.toHaveProperty('passwordHash');
    });

    it('does not let a tutor add colleagues', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .post('/api/schools/current/tutors')
        .set(await authHeader(test, tutor))
        .send({
          name: 'Sneaky',
          email: 'sneaky@example.test',
          password: TEST_PASSWORD,
        })
        .expect(403);
    });
  });
});
