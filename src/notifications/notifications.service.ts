import { Injectable } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { NotificationKind } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';

const DEFAULT_LIMIT = 50;

/**
 * Server-sent notifications only.
 *
 * The app derives lesson reminders ("did this take place?", "starting soon")
 * from the schedule it already has, so this deliberately does not duplicate
 * them: a derived reminder cannot go stale, while a stored one would need
 * retracting the moment the lesson is confirmed.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  list(user: User, limit = DEFAULT_LIMIT) {
    return this.prisma.notification.findMany({
      where: { recipientId: user.id },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  /** Idempotent: marking an already-read notification read is not an error. */
  async markRead(user: User, id: string) {
    await this.prisma.notification.updateMany({
      where: { id, recipientId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(user: User) {
    await this.prisma.notification.updateMany({
      where: { recipientId: user.id, readAt: null },
      data: { readAt: new Date() },
    });
  }

  /**
   * Sends an announcement to everyone in the school.
   *
   * A row per recipient rather than one broadcast row: read state is per person,
   * and a shared row would need a join table to track who has seen it — the same
   * data, one table further away.
   *
   * The sender is included. An announcement the author cannot see in their own
   * feed is one they cannot check went out.
   */
  async announce(sender: User, text: string) {
    const recipients = await this.prisma.user.findMany({
      where: { schoolId: sender.schoolId },
      select: { id: true },
    });

    const trimmed = text.trim();

    await this.prisma.notification.createMany({
      data: recipients.map((recipient) => ({
        kind: NotificationKind.ADMIN_ANNOUNCEMENT,
        data: { text: trimmed, personName: sender.name },
        recipientId: recipient.id,
      })),
    });

    return { recipients: recipients.length };
  }
}
