import request from 'supertest';

import { authHeader, makeSchool, makeUser } from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('User preferences', () => {
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

  it('start with reminders off', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    const response = await request(test.server)
      .get('/api/users/me/config')
      .set(await authHeader(test, user))
      .expect(200);

    // An app that starts notifying without being asked is one people mute.
    expect(response.body).toEqual({
      lessonReminders: false,
      lessonReminderMinutes: 30,
    });
  });

  it('return the whole config after a partial change', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    const response = await request(test.server)
      .patch('/api/users/me/config')
      .set(await authHeader(test, user))
      .send({ lessonReminders: true })
      .expect(200);

    // The client ends up with exactly what the server stored, including the
    // fields it did not send.
    expect(response.body).toEqual({
      lessonReminders: true,
      lessonReminderMinutes: 30,
    });
  });

  it('keep an earlier change when a later one touches another field', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });
    const header = await authHeader(test, user);

    await request(test.server)
      .patch('/api/users/me/config')
      .set(header)
      .send({ lessonReminders: true })
      .expect(200);

    const response = await request(test.server)
      .patch('/api/users/me/config')
      .set(header)
      .send({ lessonReminderMinutes: 120 })
      .expect(200);

    expect(response.body).toEqual({
      lessonReminders: true,
      lessonReminderMinutes: 120,
    });
  });

  it('persist, so a reinstalled app finds them in the session', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });
    const header = await authHeader(test, user);

    await request(test.server)
      .patch('/api/users/me/config')
      .set(header)
      .send({ lessonReminders: true, lessonReminderMinutes: 15 })
      .expect(200);

    const session = await request(test.server)
      .get('/api/auth/me')
      .set(header)
      .expect(200);

    expect(session.body.config).toEqual({
      lessonReminders: true,
      lessonReminderMinutes: 15,
    });
  });

  it('refuse a reminder so early or so late it is not a reminder', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });
    const header = await authHeader(test, user);

    await request(test.server)
      .patch('/api/users/me/config')
      .set(header)
      .send({ lessonReminderMinutes: 1 })
      .expect(400);

    await request(test.server)
      .patch('/api/users/me/config')
      .set(header)
      .send({ lessonReminderMinutes: 5000 })
      .expect(400);
  });

  it('reject a field the server does not know, rather than storing it', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    await request(test.server)
      .patch('/api/users/me/config')
      .set(await authHeader(test, user))
      .send({ lessonReminders: true, sendSmsToo: true })
      .expect(400);
  });

  it('survive a column an older build wrote', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, {
      school,
      config: { lessonReminders: 'yes', legacyDailyDigest: true },
    });

    const response = await request(test.server)
      .get('/api/users/me/config')
      .set(await authHeader(test, user))
      .expect(200);

    // A malformed config must not make an account impossible to use.
    expect(response.body).toEqual({
      lessonReminders: false,
      lessonReminderMinutes: 30,
    });
  });
});
