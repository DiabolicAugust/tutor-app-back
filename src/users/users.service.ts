import { Injectable } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  mergeUserConfig,
  parseUserConfig,
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
    const next = mergeUserConfig(user.config, patch);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { config: next },
    });

    return next;
  }
}
