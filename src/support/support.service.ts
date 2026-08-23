import { Injectable, Logger } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  /**
   * Records a support request, then tries to notify.
   *
   * The row is written **first and unconditionally**. Email can fail, a provider
   * can be unconfigured, and a request that exists only in an outbound message
   * is a request that was never received — so the row is the commitment and the
   * email is merely a notification about it.
   *
   * A failed send therefore does not fail the request: the user is told their
   * message was received, because it was. `notifiedAt` records whether anyone
   * was actually told, so undelivered requests are findable later.
   */
  async submit(user: User, message: string) {
    const request = await this.prisma.supportRequest.create({
      data: {
        message: message.trim(),
        userId: user.id,
        schoolId: user.schoolId,
      },
    });

    try {
      await this.mail.sendSupportRequest({
        requestId: request.id,
        fromName: user.name,
        fromEmail: user.email,
        schoolId: user.schoolId,
        message: request.message,
      });

      await this.prisma.supportRequest.update({
        where: { id: request.id },
        data: { notifiedAt: new Date() },
      });
    } catch (cause) {
      this.logger.error(
        `Support request ${request.id} saved but not delivered: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }

    return { id: request.id, createdAt: request.createdAt.toISOString() };
  }

  /** The caller's own history, so a follow-up does not have to be re-typed. */
  list(user: User) {
    return this.prisma.supportRequest.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, message: true, status: true, createdAt: true },
      take: 20,
    });
  }
}
