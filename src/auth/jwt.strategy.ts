import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import type { JwtClaims } from './auth.types';

/**
 * Validates the bearer token and resolves the current user.
 *
 * The user is re-read on every request rather than trusted from the token: a
 * deactivated account or a changed role must take effect immediately, and the
 * lookup is a primary-key hit.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get('JWT_SECRET', { infer: true }),
    });
  }

  async validate(claims: JwtClaims) {
    const user = await this.prisma.user.findUnique({
      where: { id: claims.sub },
    });
    if (!user) throw new UnauthorizedException('Account no longer exists');

    /**
     * A token issued under an older version is dead.
     *
     * This is what makes signing out mean anything. Without it a token is good
     * until it expires no matter what its owner does, so a phone left behind
     * keeps full access for days and nobody can do a thing about it.
     *
     * Equality, not "at least": the only valid version is the current one. A
     * token with no version predates the field and is refused, because there is
     * no way to tell whether it was issued before or after a sign-out.
     */
    if (claims.ver !== user.tokenVersion) {
      throw new UnauthorizedException('This session has been signed out');
    }

    return user;
  }
}
