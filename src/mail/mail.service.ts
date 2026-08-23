import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';

export type SupportEmail = {
  requestId: string;
  fromName: string;
  fromEmail: string;
  schoolId: string;
  message: string;
};

export type InvitationEmail = {
  to: string;
  schoolName: string;
  invitedByName: string;
  /** Deep link that opens the app on the registration form. */
  acceptUrl: string;
  expiresAt: Date;
};

/**
 * Outbound email.
 *
 * A seam, not an implementation: the same shape a real provider (Resend, SES,
 * Postmark) will satisfy, so wiring one up later touches this file and nothing
 * else. Until then `MAIL_TRANSPORT=log` writes the message — including the
 * invite link — to the server log, which is what makes the flow testable with
 * no provider account and no secrets.
 *
 * The link is logged deliberately: in development the alternative is a feature
 * nobody can try.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Returns a promise even though the log transport is synchronous: the
   * async-ness is part of the contract a real provider will fulfil, not an
   * accident of this implementation.
   */
  /**
   * Forwards a support request to whoever handles support.
   *
   * With the log transport this goes nowhere on purpose — the request is already
   * safe in the database, and this is only the notification about it.
   */
  sendSupportRequest(request: SupportEmail): Promise<void> {
    const to = this.config.get('SUPPORT_EMAIL', { infer: true });
    const body = [
      `From: ${request.fromName} <${request.fromEmail}>`,
      `School: ${request.schoolId}`,
      `Request: ${request.requestId}`,
      '',
      request.message,
    ].join('\n');

    if (this.config.get('MAIL_TRANSPORT', { infer: true }) === 'log') {
      this.logger.log(`--- support email to ${to} ---\n${body}\n---`);
      return Promise.resolve();
    }

    return Promise.reject(new Error('No mail provider is configured.'));
  }

  sendInvitation(email: InvitationEmail): Promise<void> {
    const subject = `${email.invitedByName} invited you to ${email.schoolName}`;
    const body = [
      `${email.invitedByName} invited you to join ${email.schoolName} on Fox Academy.`,
      '',
      `Open this link on your phone to finish signing up:`,
      email.acceptUrl,
      '',
      `The link expires ${email.expiresAt.toISOString()}.`,
    ].join('\n');

    if (this.config.get('MAIL_TRANSPORT', { infer: true }) === 'log') {
      this.logger.log(
        `--- email to ${email.to} ---\n${subject}\n\n${body}\n---`,
      );
      return Promise.resolve();
    }

    // Deliberately loud rather than silently dropping mail: a configuration
    // that claims to send and does not is worse than a failure.
    return Promise.reject(
      new Error(
        'No mail provider is configured. Set MAIL_TRANSPORT=log for development, or implement a provider here.',
      ),
    );
  }
}
