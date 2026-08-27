import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { User } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import {
  CredentialsService,
  SessionsService,
} from '@diabolicaugust/session-kit/nest';

import type { AuthUserPayload } from '../auth/auth.types';
import type { Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AcceptInvitationDto } from './dto/accept-invitation.dto';
import type { InviteTutorDto } from './dto/invite-tutor.dto';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class InvitationsService {
  private readonly logger = new Logger(InvitationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly notifications: NotificationsService,
    private readonly sessions: SessionsService<User, AuthUserPayload>,
    private readonly credentials: CredentialsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Invites someone to join the admin's school as a tutor.
   *
   * Re-inviting the same address replaces the previous invitation rather than
   * erroring: an admin who resends because the first mail was lost expects it to
   * work, and the unique constraint on (school, email) makes that an upsert.
   */
  async invite(admin: User, dto: InviteTutorDto) {
    const email = dto.email.trim().toLowerCase();

    if (await this.prisma.user.findUnique({ where: { email } })) {
      throw new ConflictException(
        'Someone with that email already has an account',
      );
    }

    const ttlHours = this.config.get('INVITE_TTL_HOURS', { infer: true });
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + ttlHours * HOUR_MS);

    const invitation = await this.prisma.invitation.upsert({
      where: { schoolId_email: { schoolId: admin.schoolId, email } },
      create: {
        email,
        token,
        role: UserRole.TUTOR,
        expiresAt,
        schoolId: admin.schoolId,
        invitedById: admin.id,
      },
      // A resend gets a fresh token and clock, and clears any earlier acceptance.
      update: { token, expiresAt, acceptedAt: null, invitedById: admin.id },
      include: { school: { select: { name: true } } },
    });

    const acceptUrl = this.linkFor(token);

    // Mailed *and* returned. Two channels for one token, because email is the
    // channel that can fail quietly: an address typed wrong, a domain not yet
    // verified, a spam folder. The admin gets the same link to send however they
    // like — a messenger, in person — and neither path is privileged.
    //
    // Attempted, not required. The invitation is already saved, so a mail failure
    // must not undo it and leave the admin with nothing; it is logged and the link
    // still comes back.
    const mailed = await this.mail
      .sendInvitation({
        to: email,
        schoolName: invitation.school.name,
        invitedByName: admin.name,
        acceptUrl,
        expiresAt,
      })
      .then(() => true)
      .catch((cause: unknown) => {
        this.logger.error(
          `Invitation for ${email} saved but not emailed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
        return false;
      });

    return { ...this.toPublic(invitation), acceptUrl, mailed };
  }

  /**
   * Invitations the admin has sent, newest first.
   *
   * Pending ones carry their link, so "send it again myself" does not mean
   * re-inviting and invalidating the link already in somebody's chat. Accepted
   * and expired ones do not: there is nothing left to send, and a token that no
   * longer works is only something to paste by mistake.
   *
   * Safe to include here because this route requires the capability to invite in
   * the first place — the audience that may read the link is the audience that
   * created it.
   */
  async list(admin: User) {
    const invitations = await this.prisma.invitation.findMany({
      where: { schoolId: admin.schoolId },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((invitation) => {
      const shown = this.toPublic(invitation);
      return shown.status === 'pending'
        ? { ...shown, acceptUrl: this.linkFor(invitation.token) }
        : shown;
    });
  }

  async revoke(admin: User, id: string) {
    const { count } = await this.prisma.invitation.deleteMany({
      where: { id, schoolId: admin.schoolId },
    });
    if (count === 0) throw new NotFoundException('Invitation not found');
  }

  /**
   * What the app shows on the registration form before anything is typed.
   *
   * Public, so it returns only what the recipient already knows — the school
   * they were invited to and the address it was sent to.
   */
  async describe(token: string) {
    const invitation = await this.findUsable(token);

    return {
      email: invitation.email,
      schoolName: invitation.school.name,
      invitedByName: invitation.invitedBy.name,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * Creates the account and signs it in.
   *
   * One transaction marks the invitation used and creates the user, so a link
   * cannot be redeemed twice by two simultaneous taps.
   */
  async accept(token: string, dto: AcceptInvitationDto) {
    const invitation = await this.findUsable(token);
    const passwordHash = await this.credentials.hash(dto.password);

    const user = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({
        where: { id: invitation.id, acceptedAt: null },
        data: { acceptedAt: new Date() },
      });

      if (claimed.count === 0) {
        throw new BadRequestException('This invitation has already been used');
      }

      return tx.user.create({
        data: {
          email: invitation.email,
          name: dto.name.trim(),
          role: invitation.role,
          passwordHash,
          schoolId: invitation.schoolId,
        },
      });
    });

    // After the account exists, and unable to undo it. Somebody who has just
    // registered is registered whether or not their new colleagues heard about it.
    await this.notifications.tutorJoined(user).catch((cause: unknown) => {
      this.logger.error(
        `${user.email} joined but the school was not told: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    });

    return await this.sessions.issue(user);
  }

  private async findUsable(token: string) {
    const invitation = await this.prisma.invitation.findUnique({
      where: { token },
      include: {
        school: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    });

    // One message for missing, expired and used: a link that has gone bad is a
    // link that has gone bad, and distinguishing them tells a stranger things.
    if (
      !invitation ||
      invitation.acceptedAt ||
      invitation.expiresAt < new Date()
    ) {
      throw new NotFoundException('This invitation is no longer valid');
    }

    return invitation;
  }

  /**
   * The link that opens the app on the registration form.
   *
   * One place, because it is now built for two audiences — the email and the
   * admin's own share sheet — and two spellings of the same URL is how one of
   * them ends up pointing somewhere that no longer exists.
   */
  private linkFor(token: string): string {
    return `${this.config.get('INVITE_URL_BASE', { infer: true })}/${token}`;
  }

  /** Never returns the token; callers that need the link ask `linkFor`. */
  private toPublic(invitation: {
    id: string;
    email: string;
    role: UserRole;
    expiresAt: Date;
    acceptedAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
      createdAt: invitation.createdAt.toISOString(),
      status: invitation.acceptedAt
        ? 'accepted'
        : invitation.expiresAt < new Date()
          ? 'expired'
          : 'pending',
    };
  }
}
