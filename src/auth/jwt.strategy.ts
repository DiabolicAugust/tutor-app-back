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

    return user;
  }
}
