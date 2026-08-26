import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SessionAuthModule } from '@diabolicaugust/session-kit/nest';

import type { Env } from '../config/env';
import { AuthController } from './auth.controller';
import { AuthSessionMapper, PrismaAuthUserStore } from './user-store';

/**
 * Authentication: a library, plus the two things that are genuinely ours.
 *
 * `session-kit` owns what every project rewrites and gets subtly wrong — a
 * password comparison that costs the same whether or not the account exists,
 * issuing the token, and refusing one whose session version no longer matches,
 * which is the whole of what makes signing out mean anything.
 *
 * What stays here is where users live (`PrismaAuthUserStore`), what the app is
 * told about one (`AuthSessionMapper`), and the routes. The routes stay ours
 * deliberately: their names, their validation, their rate limits and the wording
 * of their failures are exactly the parts a shared library would be wrong about,
 * and they are six lines.
 *
 * `PrismaModule` and `AddonsModule` are not imported here because both are
 * global, so the store and the mapper inject what they need without this module
 * restating it.
 */
@Module({
  imports: [
    SessionAuthModule.forRoot({
      store: PrismaAuthUserStore,
      mapper: AuthSessionMapper,
      options: {
        // Through the validated config rather than `process.env`: this project
        // reads the environment once, at boot, so a missing secret stops the
        // process instead of surfacing as a 500 on somebody's first sign-in.
        inject: [ConfigService],
        useFactory: (config: ConfigService<Env, true>) => ({
          secret: config.get('JWT_SECRET', { infer: true }),
          expiresIn: config.get('JWT_EXPIRES_IN', { infer: true }),
        }),
      },
    }),
  ],
  controllers: [AuthController],
  /**
   * Re-exported whole, which keeps two things working that would otherwise break
   * quietly.
   *
   * `SessionsService` — registration and accepting an invitation each issue a
   * session for an account they have just created, rather than sending somebody
   * to a login form to type the password they chose ten seconds ago.
   *
   * `JwtModule` — the global rate limiter verifies a token itself to know whose
   * allowance to spend, because it runs before anything has authenticated the
   * request. One place knows the signing secret.
   */
  exports: [SessionAuthModule],
})
export class AuthModule {}
