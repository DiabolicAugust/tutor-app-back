import request from 'supertest';

import { MailService } from '../src/mail/mail.service';
import { authHeader, makeSchool, makeUser } from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

const MESSAGE =
  'The calendar shows the wrong week when I switch to three days.';

describe('Support requests', () => {
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

  it('are stored, and recorded as delivered when the mail goes out', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    const response = await request(test.server)
      .post('/api/support')
      .set(await authHeader(test, user))
      .send({ message: `  ${MESSAGE}  ` })
      .expect(201);

    expect(response.body).toMatchObject({ id: expect.any(String) });

    const stored = await test.prisma.supportRequest.findFirstOrThrow();
    expect(stored).toMatchObject({
      message: MESSAGE,
      userId: user.id,
      schoolId: school.id,
      status: 'NEW',
    });
    expect(stored.notifiedAt).not.toBeNull();
  });

  it("list the caller's own history, newest first", async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });
    const colleague = await makeUser(test, { school });
    const header = await authHeader(test, user);

    await request(test.server)
      .post('/api/support')
      .set(header)
      .send({ message: MESSAGE })
      .expect(201);
    await request(test.server)
      .post('/api/support')
      .set(await authHeader(test, colleague))
      .send({ message: 'A different problem entirely.' })
      .expect(201);

    const response = await request(test.server)
      .get('/api/support')
      .set(header)
      .expect(200);

    expect(response.body).toHaveLength(1);
    expect(response.body[0].message).toBe(MESSAGE);
  });

  it('reject a message too short to act on', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    await request(test.server)
      .post('/api/support')
      .set(await authHeader(test, user))
      .send({ message: 'help' })
      .expect(400);
  });

  it('require a signed-in user', async () => {
    await request(test.server)
      .post('/api/support')
      .send({ message: MESSAGE })
      .expect(401);
  });
});

describe('Support requests when the mail provider is down', () => {
  let test: TestApp;

  beforeAll(async () => {
    // The one collaborator the outside world owns, so the one worth replacing.
    test = await createTestApp((builder) =>
      builder.overrideProvider(MailService).useValue({
        sendSupportRequest: () =>
          Promise.reject(new Error('Provider unreachable')),
        sendInvitation: () => Promise.reject(new Error('Provider unreachable')),
      }),
    );
  });
  afterAll(async () => {
    await test.close();
  });
  beforeEach(async () => {
    await test.reset();
  });

  it('still accept the request, and record that nobody was told', async () => {
    const school = await makeSchool(test);
    const user = await makeUser(test, { school });

    // The row is the commitment; the email is only a notification about it. A
    // user told "we did not receive your message" when the database has it is
    // worse than an email nobody sent.
    await request(test.server)
      .post('/api/support')
      .set(await authHeader(test, user))
      .send({ message: MESSAGE })
      .expect(201);

    const stored = await test.prisma.supportRequest.findFirstOrThrow();
    expect(stored.message).toBe(MESSAGE);
    // Null is what makes undelivered requests findable later.
    expect(stored.notifiedAt).toBeNull();
  });
});
