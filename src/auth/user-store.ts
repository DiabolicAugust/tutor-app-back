import { Injectable } from '@nestjs/common';

import type {
  AuthUserStore,
  SessionUserMapper,
} from '@diabolicaugust/session-kit/nest';

import type { User } from '../../generated/prisma/client';
import { AddonsService } from '../addons/addons.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseUserConfig } from '../users/user-config';
import type { AuthUserPayload } from './auth.types';

/**
 * Where this application keeps its users, told to `session-kit`.
 *
 * The library owns the mechanism — comparing a password without leaking which
 * half was wrong, issuing a token, refusing a revoked one — and owns none of the
 * storage. This is the whole of what it needs to know about ours.
 */
@Injectable()
export class PrismaAuthUserStore implements AuthUserStore<User> {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The email arrives already trimmed and lower-cased, so it is looked up as
   * stored. Registration normalises the same way — see `schools.service` — which
   * is what stops "Anna@…" and "anna@…" becoming two accounts.
   */
  findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({ where: { id } });
  }

  idOf(user: User): string {
    return user.id;
  }

  passwordHashOf(user: User): string {
    return user.passwordHash;
  }

  sessionVersionOf(user: User): number {
    return user.tokenVersion;
  }

  /**
   * An increment rather than a write of a value read a moment ago, so two taps
   * racing each other both end up revoking instead of one overwriting the other
   * with the same number.
   */
  async revokeSessions(user: User): Promise<void> {
    await this.prisma.user.update({
      where: { id: user.id },
      data: { tokenVersion: { increment: 1 } },
    });
  }
}

/**
 * What the app is told about the person who just signed in.
 *
 * Capabilities and preferences travel with the very first payload rather than
 * being fetched per screen: the app needs both to decide what to render on its
 * first frame, and a permission that arrives a moment late is UI flickering into
 * existence.
 */
@Injectable()
export class AuthSessionMapper implements SessionUserMapper<
  User,
  AuthUserPayload
> {
  constructor(private readonly addons: AddonsService) {}

  async toPayload(user: User): Promise<AuthUserPayload> {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role.toLowerCase() as AuthUserPayload['role'],
      schoolId: user.schoolId,
      addons: await this.addons.resolveFor(user),
      // Parsed rather than passed through: the column may hold whatever an older
      // build wrote.
      config: parseUserConfig(user.config),
    };
  }
}
