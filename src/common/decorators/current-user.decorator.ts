/**
 * The authenticated user, from `session-kit`.
 *
 * Typed by the caller — `@CurrentUser() user: User` — because the library never
 * knew what a user was here and should not start pretending at the last moment.
 */
export { CurrentUser } from '@diabolicaugust/session-kit/nest';
