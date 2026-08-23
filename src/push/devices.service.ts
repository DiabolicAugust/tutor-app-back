import { Injectable } from '@nestjs/common';

import type { PushToken, User } from '../../generated/prisma/client';
import type { DevicePlatform } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DevicesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a device as belonging to this user.
   *
   * An upsert on the token, which is what makes the awkward case correct: a phone
   * handed to a colleague, or somebody signing out and back in as somebody else,
   * arrives with a token that already exists. Reassigning it means the previous
   * owner stops receiving that device's notifications — creating a second row
   * would send them to both people.
   */
  register(
    user: User,
    token: string,
    platform: DevicePlatform,
  ): Promise<PushToken> {
    return this.prisma.pushToken.upsert({
      where: { token },
      create: { token, platform, userId: user.id },
      update: { userId: user.id, platform, lastSeenAt: new Date() },
    });
  }

  /**
   * Forgets a device, on sign-out.
   *
   * Scoped to the caller so one account cannot unregister another's device, and
   * silent about a token it does not hold: a client retrying a sign-out should
   * not get an error for having already succeeded.
   */
  async unregister(user: User, token: string): Promise<void> {
    await this.prisma.pushToken.deleteMany({
      where: { token, userId: user.id },
    });
  }

  /** Every device belonging to any of these users. */
  tokensFor(userIds: readonly string[]): Promise<PushToken[]> {
    if (userIds.length === 0) return Promise.resolve([]);

    return this.prisma.pushToken.findMany({
      where: { userId: { in: [...userIds] } },
    });
  }

  /**
   * Drops tokens the push service has rejected as unregistered.
   *
   * Called after a send. Without it the table keeps every token an app ever
   * issued, and each reinstall adds another dead one to notify.
   */
  async retire(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) return;

    await this.prisma.pushToken.deleteMany({
      where: { token: { in: [...tokens] } },
    });
  }
}
