import { BadRequestException, Injectable } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  mergeUserConfig,
  parseUserConfig,
  userConfigPatchSchema,
  type UserConfig,
  type UserConfigPatch,
} from './user-config';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /** Always a complete config, whatever the column happens to hold. */
  getConfig(user: User): UserConfig {
    return parseUserConfig(user.config);
  }

  /**
   * Applies a patch and returns the whole config.
   *
   * Returns the merged result rather than an acknowledgement so the client ends
   * up with exactly what the server stored — including any field the server
   * clamped or defaulted.
   */
  async updateConfig(user: User, patch: UserConfigPatch): Promise<UserConfig> {
    // The one place a bad meeting room is refused out loud. Reads repair
    // themselves quietly, because an old column must not lock somebody out of
    // their settings; a write must not, because silently storing "no meeting"
    // looks exactly like the setting having saved.
    const checked = userConfigPatchSchema.safeParse(patch);
    if (!checked.success) {
      throw new BadRequestException(
        checked.error.issues[0]?.message ?? 'Those settings are not valid',
      );
    }

    const next = mergeUserConfig(user.config, checked.data);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { config: next },
    });

    return next;
  }
}
