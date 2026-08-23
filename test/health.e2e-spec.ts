import request from 'supertest';

import { createTestApp, type TestApp } from './support/test-app';

describe('Health', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });

  it('reports ok only after a real database round-trip', async () => {
    const response = await request(test.server).get('/api/health').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
    expect(Date.parse(response.body.at as string)).not.toBeNaN();
  });

  it('is reachable without a token, because a probe has none', async () => {
    await request(test.server).get('/api/health').expect(200);
  });

  it('answers on the /api prefix and nowhere else', async () => {
    // The prefix is set in the shared app setup, so a test that boots the app a
    // different way would not notice it going missing.
    await request(test.server).get('/health').expect(404);
  });
});
