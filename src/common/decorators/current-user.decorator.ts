import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

import type { User } from '../../../generated/prisma/client';

/**
 * The authenticated user, as resolved by `JwtStrategy`.
 *
 * Controllers take this instead of reading `request.user`, which keeps the
 * `any` that Express hands back out of feature code.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    return context.switchToHttp().getRequest<{ user: User }>().user;
  },
);
