import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';

/** One notification, addressed to one device. */
export type PushMessage = {
  /** An Expo push token. */
  to: string;
  title: string;
  body: string;
  /** Delivered to the app when the notification is opened. */
  data?: Record<string, unknown>;
  /** Android channel to deliver on; the app creates them. */
  channelId?: string;
};

/**
 * Tokens the push service says are no longer deliverable.
 *
 * Returned rather than deleted here: this class knows how to talk to a push
 * service and nothing about the database. The caller owns the rows.
 */
export type PushResult = { retiredTokens: string[] };

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
/** Expo accepts up to 100 messages per request. */
const BATCH_SIZE = 100;

type ExpoTicket = {
  status: 'ok' | 'error';
  id?: string;
  message?: string;
  details?: { error?: string };
};

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  /**
   * Sends notifications, and reports which tokens have died.
   *
   * Never throws for a delivery failure. A push is a notification *about*
   * something that has already happened — the announcement is a row in the
   * database either way — so failing the caller's request because a phone could
   * not be reached would trade a real success for a fake failure.
   */
  async send(messages: readonly PushMessage[]): Promise<PushResult> {
    if (messages.length === 0) return { retiredTokens: [] };

    if (this.config.get('PUSH_TRANSPORT', { infer: true }) === 'log') {
      for (const message of messages) {
        this.logger.log(
          `--- push to ${message.to} ---\n${message.title}\n${message.body}\n---`,
        );
      }
      return { retiredTokens: [] };
    }

    const retiredTokens: string[] = [];

    for (let index = 0; index < messages.length; index += BATCH_SIZE) {
      const batch = messages.slice(index, index + BATCH_SIZE);
      retiredTokens.push(...(await this.sendBatch(batch)));
    }

    return { retiredTokens };
  }

  /** One request to Expo. Returns the tokens it rejected as unregistered. */
  private async sendBatch(batch: readonly PushMessage[]): Promise<string[]> {
    const accessToken = this.config.get('EXPO_ACCESS_TOKEN', { infer: true });

    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(batch),
      });

      if (!response.ok) {
        this.logger.error(`Push service answered ${response.status}`);
        return [];
      }

      const payload = (await response.json()) as { data?: ExpoTicket[] };
      const tickets = payload.data ?? [];

      // Tickets come back in the order they were sent, which is the only thing
      // tying an error back to the token that caused it.
      return tickets.flatMap((ticket, position) => {
        if (ticket.status === 'ok') return [];

        const token = batch[position]?.to;
        this.logger.warn(
          `Push rejected for ${token}: ${ticket.message ?? 'unknown error'}`,
        );

        // The one error worth acting on: the app was uninstalled or the token
        // replaced. Anything else may be transient, and deleting a token over a
        // temporary fault would silently stop notifying somebody forever.
        return ticket.details?.error === 'DeviceNotRegistered' && token
          ? [token]
          : [];
      });
    } catch (cause) {
      this.logger.error(
        `Could not reach the push service: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return [];
    }
  }
}
