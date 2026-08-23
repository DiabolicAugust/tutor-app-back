import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import type { User } from '../../../generated/prisma/client';
import type { UserRole } from '../../../generated/prisma/enums';
import { ROLES_KEY } from '../decorators/roles.decorator';

/**
 * Enforces `@Roles(...)`. Must run after the JWT guard, which is what puts the
 * user on the request — listing it second in `@UseGuards` does that.
 *
 * A route with no `@Roles` is open to any authenticated user; the JWT guard has
 * already done the authentication half.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<UserRole[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required?.length) return true;

    const { user } = context.switchToHttp().getRequest<{ user?: User }>();
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('Your role does not allow this');
    }

    return true;
  }
}
