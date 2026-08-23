import { randomBytes } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { User } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import { AuthService } from '../auth/auth.service';
import type { Env } from '../config/env';
import { MailService } from '../mail/mail.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AcceptInvitationDto } from './dto/accept-invitation.dto';
import type { InviteTutorDto } from './dto/invite-tutor.dto';

const HOUR_MS = 60 * 60 * 1000;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly auth: AuthService,
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

    await this.mail.sendInvitation({
      to: email,
      schoolName: invitation.school.name,
      invitedByName: admin.name,
      acceptUrl: `${this.config.get('INVITE_URL_BASE', { infer: true })}/${token}`,
      expiresAt,
    });

    return this.toPublic(invitation);
  }

  /** Invitations the admin has sent, newest first. */
  async list(admin: User) {
    const invitations = await this.prisma.invitation.findMany({
      where: { schoolId: admin.schoolId },
      orderBy: { createdAt: 'desc' },
    });

    return invitations.map((invitation) => this.toPublic(invitation));
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
    const passwordHash = await AuthService.hashPassword(dto.password);

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

    return await this.auth.issueSession(user);
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

  /** Never returns the token — that belongs only in the email. */
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
