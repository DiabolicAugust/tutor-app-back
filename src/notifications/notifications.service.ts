import { Injectable, Logger } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { NotificationKind } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { DevicesService } from '../push/devices.service';
import { PushService } from '../push/push.service';

const DEFAULT_LIMIT = 50;

/**
 * The Android channel announcements arrive on.
 *
 * Its own channel, not the lesson-reminder one. Android lets people mute a
 * channel, and "the school is telling you something" and "your lesson starts in
 * half an hour" are things somebody may well want to treat differently. It also
 * keeps the reminder chime meaning one thing.
 */
const ANNOUNCEMENT_CHANNEL_ID = 'announcements';

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
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly devices: DevicesService,
    private readonly push: PushService,
  ) {}

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
    const [recipients, school] = await Promise.all([
      this.prisma.user.findMany({
        where: { schoolId: sender.schoolId },
        select: { id: true },
      }),
      this.prisma.school.findUnique({
        where: { id: sender.schoolId },
        select: { name: true },
      }),
    ]);

    const trimmed = text.trim();

    await this.prisma.notification.createMany({
      data: recipients.map((recipient) => ({
        kind: NotificationKind.ADMIN_ANNOUNCEMENT,
        data: { text: trimmed, personName: sender.name },
        recipientId: recipient.id,
      })),
    });

    const delivered = await this.pushAnnouncement(
      recipients.map((recipient) => recipient.id),
      school?.name ?? sender.name,
      trimmed,
    );

    return { recipients: recipients.length, devices: delivered };
  }

  /**
   * Pushes an announcement to every device its recipients have registered.
   *
   * After the rows, never instead of them, and never able to fail the request:
   * the feed is where an announcement lives, and a push is only a tap on the
   * shoulder about it. A school whose announcement failed to send would be a
   * worse outcome than one whose phones stayed quiet.
   *
   * The body is the announcement itself, untranslated — somebody wrote those
   * words and they are already in the language they meant. The title is the
   * school's name, which needs no translating either. That matters because the
   * OS renders this while the app is not running: the server cannot ask which
   * language the reader prefers, so the only honest text is text that does not
   * depend on knowing.
   */
  private async pushAnnouncement(
    recipientIds: readonly string[],
    schoolName: string,
    text: string,
  ): Promise<number> {
    try {
      const devices = await this.devices.tokensFor(recipientIds);
      if (devices.length === 0) return 0;

      const { retiredTokens } = await this.push.send(
        devices.map((device) => ({
          to: device.token,
          title: schoolName,
          body: text,
          channelId: ANNOUNCEMENT_CHANNEL_ID,
          // Enough for the app to open the right screen when it is tapped.
          data: { kind: NotificationKind.ADMIN_ANNOUNCEMENT },
        })),
      );

      await this.devices.retire(retiredTokens);
      return devices.length - retiredTokens.length;
    } catch (cause) {
      this.logger.error(
        `Announcement stored but not pushed: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return 0;
    }
  }
}
