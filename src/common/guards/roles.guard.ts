/**
 * Enforces `@Roles(...)`, from `session-kit`.
 *
 * Re-exported rather than reimplemented. The rule is small — read the role the
 * JWT guard put on the request, compare it against the decorator — and it was
 * identical in every project that had it.
 *
 * Must still run *after* `JwtAuthGuard`, which is what puts the user there;
 * listing it second in `@UseGuards` does that.
 */
export { RolesGuard } from '@diabolicaugust/session-kit/nest';
