import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';

import { AddonsService } from '../addons/addons.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseUserConfig } from '../users/user-config';
import type { AuthUserPayload, JwtClaims, SessionPayload } from './auth.types';
import type { SignInDto } from './dto/sign-in.dto';
import type { User } from '../../generated/prisma/client';

/** Cost factor. 12 is the usual balance of "slow enough" and "not a timeout". */
const BCRYPT_ROUNDS = 12;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly addons: AddonsService,
  ) {}

  /**
   * Verifies credentials and issues a session.
   *
   * The same error is returned whether the email is unknown or the password is
   * wrong, so the endpoint cannot be used to enumerate accounts.
   */
  async signIn({ email, password }: SignInDto): Promise<SessionPayload> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.trim().toLowerCase() },
    });

    const passwordMatches = user
      ? await bcrypt.compare(password, user.passwordHash)
      : // Compare against a dummy hash anyway, so a missing account and a wrong
        // password take a similar amount of time.
        await bcrypt.compare(
          password,
          '$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva',
        );

    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Incorrect email or password');
    }

    return this.issueSession(user);
  }

  /** Turns a user row into the session shape the mobile app persists. */
  async issueSession(user: User): Promise<SessionPayload> {
    const claims: JwtClaims = {
      sub: user.id,
      email: user.email,
      schoolId: user.schoolId,
      role: user.role,
      // The version as it stands now. Signing in does not bump it, so a second
      // device does not sign the first one out — which is not what anybody means
      // by signing in.
      ver: user.tokenVersion,
    };

    return {
      user: toAuthUser(user, await this.addons.resolveFor(user)),
      token: this.jwt.sign(claims),
      issuedAt: new Date().toISOString(),
    };
  }

  /**
   * Signs the account out everywhere.
   *
   * Everywhere, and not only on the device asking: there is no way to name a
   * single token and no reason to want one. Somebody signing out because a phone
   * is lost means all of them, and somebody signing out on their own phone loses
   * nothing by having their tablet ask for a password again.
   *
   * An increment rather than a write of a computed value, so two taps racing each
   * other both end up revoking rather than one overwriting the other with the
   * same number.
   */
  async signOut(user: User): Promise<void> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
  }

  static hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }
}

/**
 * Maps a user row to what the app stores as its session user. The two
 * vocabularies differ only in case, so this stays a one-liner — but it stays a
 * function, so a future divergence has an obvious home.
 */
export function toAuthUser(
  user: User,
  addons: AuthUserPayload['addons'],
): AuthUserPayload {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role.toLowerCase() as AuthUserPayload['role'],
    schoolId: user.schoolId,
    addons,
    // Parsed rather than passed through: the column may hold whatever an older
    // build wrote.
    config: parseUserConfig(user.config),
  };
}
