import { Controller, Get, INestApplication, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';

import { ThrottlerByCallerGuard } from '../src/common/guards/throttler-by-caller.guard';

/**
 * The rate limiter, on its own.
 *
 * A module of its own rather than the application's, for one reason: the app
 * turns throttling off under `NODE_ENV=test`, because the rest of this suite
 * signs in hundreds of times in half a minute and would spend the allowance on
 * its own fixtures. That is the right trade for those tests and it would leave
 * this behaviour untested, so here it is turned back on and pointed at a
 * controller that does nothing.
 *
 * What is worth proving is not that `@nestjs/throttler` counts — it does — but
 * the part this repository wrote: *what* it counts. Two colleagues behind one
 * office address must not share an allowance, and a caller inventing tokens must
 * not be able to mint fresh ones.
 */
const SECRET = 'throttling-spec-secret-at-least-thirty-two-chars';
const LIMIT = 3;

@Controller('probe')
class ProbeController {
  @Get()
  ping() {
    return { ok: true };
  }
}

@Module({
  imports: [
    JwtModule.register({ secret: SECRET }),
    ThrottlerModule.forRoot({
      throttlers: [{ name: 'short', ttl: 60_000, limit: LIMIT }],
    }),
  ],
  controllers: [ProbeController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerByCallerGuard }],
})
class ProbeModule {}

describe('Rate limiting', () => {
  let app: INestApplication;
  let jwt: JwtService;
  /** Typed once: `getHttpServer()` is `any`, and supertest is happy with it. */
  let server: Parameters<typeof request>[0];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ProbeModule],
    }).compile();

    app = moduleRef.createNestApplication();
    jwt = app.get(JwtService);
    await app.init();
    server = app.getHttpServer();
  });

  afterEach(async () => {
    await app.close();
  });

  const asAccount = (id: string) => ({
    Authorization: `Bearer ${jwt.sign({ sub: id })}`,
  });

  it('lets a caller through up to the limit and then refuses', async () => {
    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await request(server).get('/probe').expect(200);
    }

    await request(server).get('/probe').expect(429);
  });

  it('gives each account its own allowance', async () => {
    const anna = asAccount('user-anna');
    const olena = asAccount('user-olena');

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await request(server).get('/probe').set(anna).expect(200);
    }
    await request(server).get('/probe').set(anna).expect(429);

    // The same address, a different account. A school is several people on one
    // office connection, and the fifth to arrive must not find the allowance
    // already spent by the other four.
    await request(server).get('/probe').set(olena).expect(200);
  });

  it('counts a request with no token separately from a signed-in one', async () => {
    const anna = asAccount('user-anna');

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await request(server).get('/probe').set(anna).expect(200);
    }
    await request(server).get('/probe').set(anna).expect(429);

    // Anonymous callers share the address bucket, which is untouched by Anna.
    await request(server).get('/probe').expect(200);
  });

  it('does not hand out a fresh allowance for an invented token', async () => {
    // Each of these carries a different `sub`, and none of them is signed with
    // the server's secret. Read without verifying, they would each look like a
    // new account and the limit would not exist.
    const forged = (id: string) => ({
      Authorization: `Bearer ${new JwtService({ secret: 'not-the-secret' }).sign({ sub: id })}`,
    });

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await request(server)
        .get('/probe')
        .set(forged(`invented-${attempt}`))
        .expect(200);
    }

    await request(server)
      .get('/probe')
      .set(forged('invented-again'))
      .expect(429);
  });

  it('treats a malformed authorization header as anonymous', async () => {
    const nonsense = { Authorization: 'Bearer not-even-a-token' };

    for (let attempt = 0; attempt < LIMIT; attempt += 1) {
      await request(server).get('/probe').set(nonsense).expect(200);
    }

    await request(server).get('/probe').set(nonsense).expect(429);
  });
});
