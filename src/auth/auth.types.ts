import type { AddonKey, UserRole } from '../../generated/prisma/enums';
import type { UserConfig } from '../users/user-config';

/**
 * What the mobile app stores as its session.
 *
 * Field names match the app's `Session` and `AuthUser` types exactly, so its
 * `AuthClient` implementation is a fetch and a cast rather than a mapping layer.
 */
export type AuthUserPayload = {
  id: string;
  email: string;
  name: string;
  role: Lowercase<UserRole>;
  schoolId: string | null;
  /**
   * Capabilities this account holds, sent with the user's first payload.
   *
   * In the session rather than fetched per screen: the app needs them to decide
   * what to render on its very first frame, and a permission that arrives a
   * moment late means UI that flickers into existence.
   */
  addons: AddonKey[];
  /**
   * Preferences, sent with the same first payload as the addons.
   *
   * The settings screen can then render its current state immediately instead of
   * showing defaults and correcting itself a moment later.
   */
  config: UserConfig;
};

export type SessionPayload = {
  user: AuthUserPayload;
  token: string;
  issuedAt: string;
};

/** Claims carried in the access token. Kept minimal — everything else is a query. */
export type JwtClaims = {
  sub: string;
  email: string;
  schoolId: string;
  role: UserRole;
};
