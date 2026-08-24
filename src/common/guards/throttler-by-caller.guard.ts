import { Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import {
  ThrottlerGuard,
  getOptionsToken,
  getStorageToken,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';
import type { Request } from 'express';

import type { User } from '../../../generated/prisma/client';

/**
 * Rate limiting, counted per *caller* rather than strictly per address.
 *
 * The distinction matters both ways:
 *
 * - **Authenticated requests are counted per account.** A tutoring school is
 *   several people on one office connection, and a shared address means the
 *   fifth person to arrive finds the allowance already spent by their
 *   colleagues. The account is also the right thing to count: abuse of an
 *   authenticated endpoint is an account misbehaving, and it should not be able
 *   to escape by changing networks.
 *
 * - **Everything else is counted per address**, because there is nothing else to
 *   count. These are the endpoints that decide whether the server stays up —
 *   signing in costs a bcrypt comparison, registering a school costs another —
 *   so this is where a flood has to stop.
 *
 * The prefix keeps the two spaces apart, so a signed-in user can never spend an
 * address's allowance or the other way round.
 */
@Injectable()
export class ThrottlerByCallerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly jwt: JwtService,
  ) {
    super(options, storageService, reflector);
  }

  protected getTracker(request: Request): Promise<string> {
    const account = this.accountFrom(request);

    // The base class's signature is asynchronous; nothing here needs to be, so
    // this returns a settled promise rather than pretending to wait.
    return Promise.resolve(
      account ? `user:${account}` : `ip:${this.addressOf(request)}`,
    );
  }

  /**
   * Who is making this request, if the token says so.
   *
   * The token is verified **here**, rather than read from `request.user`, and
   * that is the whole reason this class exists rather than a two-line override.
   * This guard is global and `JwtAuthGuard` is applied per controller; Nest runs
   * global guards first, so at this point nothing has authenticated anybody and
   * `request.user` is empty on every request. Counting would silently fall back
   * to the address for everyone, and the per-account behaviour above would be a
   * comment describing something that never happened.
   *
   * Verified rather than merely decoded, and this is not caution for its own
   * sake: an unverified `sub` is a value the caller chooses, so a client could
   * hand itself a fresh allowance per request and have no limit at all. A failed
   * verification falls through to the address, which is what keeps a flood of
   * forged tokens counted as the one caller it is.
   *
   * `request.user` is still preferred when something has already set it, so this
   * keeps working if authentication ever moves in front of it.
   */
  private accountFrom(request: Request): string | null {
    const existing = (request as Request & { user?: User }).user;
    if (existing?.id) return existing.id;

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;

    try {
      const claims = this.jwt.verify<{ sub?: string }>(header.slice(7).trim());
      return claims.sub ?? null;
    } catch {
      return null;
    }
  }

  /**
   * The client's address as this process can best determine it.
   *
   * `request.ip` is trustworthy only because `trust proxy` is configured in
   * `app-setup.ts`. Without that it reports the platform's load balancer for
   * every request, which would put the entire internet in one bucket and lock
   * everybody out together.
   *
   * The fallback collapses to a single bucket on purpose: an unidentifiable
   * caller sharing an allowance is a nuisance, while giving each one its own is
   * the same as having no limit.
   */
  private addressOf(request: Request): string {
    return request.ip ?? request.socket?.remoteAddress ?? 'unknown';
  }
}
