/**
 * Restricts a route to certain roles, from `session-kit`.
 *
 * Generic over whatever an application calls its roles, so passing a `UserRole`
 * keeps the same protection against a typo that a local definition gave.
 */
export { Roles, ROLES_KEY } from '@diabolicaugust/session-kit/nest';
