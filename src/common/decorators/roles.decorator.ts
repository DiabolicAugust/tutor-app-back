import { SetMetadata } from '@nestjs/common';

import type { UserRole } from '../../../generated/prisma/enums';

export const ROLES_KEY = 'roles';

/**
 * Restricts a route to the listed roles.
 *
 * Declarative on purpose: `if (user.role !== 'ADMIN') throw` scattered through
 * services makes the permission model something you have to read the whole
 * codebase to know. Here it is visible on the handler.
 *
 * Data *scoping* is a different question and stays in the services — an admin
 * and a tutor may both call an endpoint and legitimately see different rows.
 */
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
