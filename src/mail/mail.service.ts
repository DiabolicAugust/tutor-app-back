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

/** One message, in the only two forms every provider accepts. */
type Outgoing = {
  to: string;
  subject: string;
  text: string;
};

/**
 * Outbound email.
 *
 * Two transports behind one seam. `MAIL_TRANSPORT=log` writes the message —
 * invitation link included — to the server log and sends nothing, which is what
 * makes the flow testable with no provider account and no secrets. The link is
 * logged deliberately: in development the alternative is a feature nobody can
 * try. `resend` sends for real.
 *
 * Resend rather than a competitor's larger free tier for one reason that matters
 * here: the others stamp their own logo into the message body, and an invitation
 * to join a school carrying a third party's badge is exactly where that reads as
 * spam.
 *
 * Plain `fetch` rather than the provider's SDK. The request is a POST with four
 * fields, and a dependency that owns the wire format is one that has to be
 * upgraded to change it.
 *
 * **Email is not the only way an invitation travels** — `InvitationsService` also
 * hands the admin the link to send however they like. That is why a failure here
 * is loud rather than fatal: the invitation is already saved, and there is
 * another way to deliver it.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Sends, or logs — one place, so both message kinds behave the same way and
   * neither can grow its own idea of what a transport is.
   *
   * Returns a promise even under the log transport, which is synchronous: the
   * async-ness is part of the contract a real provider fulfils, not an accident
   * of one implementation.
   */
  private async deliver(message: Outgoing): Promise<void> {
    if (this.config.get('MAIL_TRANSPORT', { infer: true }) === 'log') {
      this.logger.log(
        [
          `--- email to ${message.to} ---`,
          message.subject,
          '',
          message.text,
          '---',
        ].join('\n'),
      );
      return;
    }

    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.config.get('RESEND_API_KEY', {
          infer: true,
        })}`,
      },
      body: JSON.stringify({
        from: this.config.get('MAIL_FROM', { infer: true }),
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });

    if (response.ok) return;

    // The provider's own words, because they are the useful ones: "domain is not
    // verified" and "invalid api key" need different fixes, and a generic message
    // sends somebody looking in the wrong place. The recipient is named; the body
    // is not, since it carries a token that grants access to a school.
    const detail = await response
      .text()
      .then((body) => body.slice(0, 300))
      .catch(() => '');

    throw new Error(
      `Could not send email to ${message.to}: ${response.status} ${detail}`,
    );
  }

  /**
   * Forwards a support request to whoever handles support.
   *
   * With the log transport this goes nowhere on purpose — the request is already
   * safe in the database, and this is only the notification about it.
   */
  sendSupportRequest(request: SupportEmail): Promise<void> {
    return this.deliver({
      to: this.config.get('SUPPORT_EMAIL', { infer: true }),
      subject: `Support request ${request.requestId}`,
      text: [
        `From: ${request.fromName} <${request.fromEmail}>`,
        `School: ${request.schoolId}`,
        `Request: ${request.requestId}`,
        '',
        request.message,
      ].join('\n'),
    });
  }

  sendInvitation(email: InvitationEmail): Promise<void> {
    return this.deliver({
      to: email.to,
      subject: `${email.invitedByName} invited you to ${email.schoolName}`,
      text: [
        `${email.invitedByName} invited you to join ${email.schoolName} on Fox Academy.`,
        '',
        'Open this link on your phone to finish signing up:',
        email.acceptUrl,
        '',
        `The link expires ${email.expiresAt.toISOString()}.`,
      ].join('\n'),
    });
  }
}
