import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { AddonKey, UserRole } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Capability grants.
 *
 * One rule worth stating once: **an admin implicitly holds every addon.** They
 * are the person who grants them, so requiring an admin to grant themselves
 * permission to grant permissions is a loop with no useful first step. Every
 * check goes through `resolveFor`, so that rule lives in exactly one place.
 */
@Injectable()
export class AddonsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Everything this user may do, role included. */
  async resolveFor(user: User): Promise<AddonKey[]> {
    if (user.role === UserRole.ADMIN) return Object.values(AddonKey);

    const granted = await this.prisma.userAddon.findMany({
      where: { userId: user.id },
      select: { addon: true },
    });

    return granted.map((row) => row.addon);
  }

  async has(user: User, addon: AddonKey): Promise<boolean> {
    return (await this.resolveFor(user)).includes(addon);
  }

  /**
   * Replaces a member's grants with exactly `addons`.
   *
   * A replace rather than add/remove endpoints: the admin UI shows a set of
   * toggles and submits what it wants to be true, which makes the operation
   * idempotent and immune to a lost request leaving a half-applied state.
   */
  async setFor(
    admin: User,
    userId: string,
    addons: AddonKey[],
  ): Promise<AddonKey[]> {
    const target = await this.prisma.user.findUnique({ where: { id: userId } });

    // Same-school only, and 404 rather than 403 so the endpoint cannot be used
    // to discover accounts elsewhere.
    if (!target || target.schoolId !== admin.schoolId) {
      throw new NotFoundException('Member not found');
    }
    if (target.role === UserRole.ADMIN) {
      throw new ForbiddenException('Admins already hold every capability');
    }

    const unique = [...new Set(addons)];

    await this.prisma.$transaction([
      this.prisma.userAddon.deleteMany({
        where: { userId, addon: { notIn: unique } },
      }),
      // `skipDuplicates` makes re-submitting the same set a no-op rather than a
      // unique-constraint error.
      this.prisma.userAddon.createMany({
        data: unique.map((addon) => ({ userId, addon, enabledById: admin.id })),
        skipDuplicates: true,
      }),
    ]);

    return unique;
  }

  /** Grants for several members at once, for the school roster screen. */
  async mapForSchool(schoolId: string): Promise<Record<string, AddonKey[]>> {
    const rows = await this.prisma.userAddon.findMany({
      where: { user: { schoolId } },
      select: { userId: true, addon: true },
    });

    return rows.reduce<Record<string, AddonKey[]>>((acc, row) => {
      (acc[row.userId] ??= []).push(row.addon);
      return acc;
    }, {});
  }
}
