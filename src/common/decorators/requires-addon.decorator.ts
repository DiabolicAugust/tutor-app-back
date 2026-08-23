import { SetMetadata } from '@nestjs/common';

import type { AddonKey } from '../../../generated/prisma/enums';

export const ADDON_KEY = 'requiredAddon';

/**
 * Requires a capability on the handler.
 *
 * Separate from `@Roles` because they answer different questions: a role is a
 * job, an addon is a permission. Endpoints that a school might want to delegate
 * — inviting, broadcasting — are gated on the addon, so an admin can hand them
 * to a senior tutor without making that tutor an admin.
 */
export const RequiresAddon = (addon: AddonKey) => SetMetadata(ADDON_KEY, addon);
