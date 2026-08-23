import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { User } from '../../../generated/prisma/client';
import { AddonKey, UserRole } from '../../../generated/prisma/enums';
import type { AddonsService } from '../../addons/addons.service';
import { AddonGuard } from './addon.guard';
import { RolesGuard } from './roles.guard';

/** A context carrying whatever the test wants on the request. */
const contextWith = (user?: Partial<User>): ExecutionContext =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

/** A reflector that reports one metadata value, whatever is asked for. */
const reflectorReturning = (value: unknown): Reflector =>
  ({ getAllAndOverride: () => value }) as unknown as Reflector;

describe('RolesGuard', () => {
  it('lets an authenticated caller through when no role is required', () => {
    // Authentication has already happened; this guard only answers "which job".
    const guard = new RolesGuard(reflectorReturning(undefined));

    expect(guard.canActivate(contextWith({ role: UserRole.TUTOR }))).toBe(true);
  });

  it('treats an empty role list as no requirement', () => {
    const guard = new RolesGuard(reflectorReturning([]));

    expect(guard.canActivate(contextWith({ role: UserRole.TUTOR }))).toBe(true);
  });

  it('lets a matching role through', () => {
    const guard = new RolesGuard(reflectorReturning([UserRole.ADMIN]));

    expect(guard.canActivate(contextWith({ role: UserRole.ADMIN }))).toBe(true);
  });

  it('refuses a role that does not match', () => {
    const guard = new RolesGuard(reflectorReturning([UserRole.ADMIN]));

    expect(() =>
      guard.canActivate(contextWith({ role: UserRole.TUTOR })),
    ).toThrow(ForbiddenException);
  });

  it('refuses when there is no user at all', () => {
    // Would mean the JWT guard was not listed first, and failing closed is the
    // only safe answer to a misordered guard chain.
    const guard = new RolesGuard(reflectorReturning([UserRole.ADMIN]));

    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});

describe('AddonGuard', () => {
  const addonsHolding = (held: AddonKey[]): AddonsService =>
    ({
      has: (_user: User, addon: AddonKey) =>
        Promise.resolve(held.includes(addon)),
    }) as unknown as AddonsService;

  it('lets a route with no requirement through', async () => {
    const guard = new AddonGuard(
      reflectorReturning(undefined),
      addonsHolding([]),
    );

    await expect(guard.canActivate(contextWith({ id: 'u1' }))).resolves.toBe(
      true,
    );
  });

  it('lets a holder of the capability through', async () => {
    const guard = new AddonGuard(
      reflectorReturning(AddonKey.MANAGE_STUDENTS),
      addonsHolding([AddonKey.MANAGE_STUDENTS]),
    );

    await expect(guard.canActivate(contextWith({ id: 'u1' }))).resolves.toBe(
      true,
    );
  });

  it('refuses somebody holding a different capability', async () => {
    const guard = new AddonGuard(
      reflectorReturning(AddonKey.MANAGE_STUDENTS),
      addonsHolding([AddonKey.INVITE_TUTORS]),
    );

    await expect(guard.canActivate(contextWith({ id: 'u1' }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('refuses when there is no user', async () => {
    const guard = new AddonGuard(
      reflectorReturning(AddonKey.MANAGE_STUDENTS),
      addonsHolding([AddonKey.MANAGE_STUDENTS]),
    );

    await expect(guard.canActivate(contextWith(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
