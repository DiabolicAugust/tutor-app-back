import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import {
  AccessTokenCache,
  parseServiceAccount,
  type ServiceAccount,
} from './fcm-credentials';

/** One notification, addressed to one device. */
export type PushMessage = {
  /** The device's own FCM registration token, as the app reported it. */
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

/**
 * How many devices to notify at once.
 *
 * FCM's v1 API sends to one token per request — the batch endpoint it used to
 * offer is gone — so this is a concurrency limit rather than a batch size. Kept
 * modest: a school-wide announcement should not open two hundred sockets, and
 * the request that triggered it is not waiting on delivery anyway.
 */
const CONCURRENCY = 10;

/**
 * The errors that mean a token is dead rather than the network being unhappy.
 *
 * `NOT_FOUND` is what FCM actually answers for a token it no longer knows — the
 * word `UNREGISTERED` appears only in the error *details*, which cost a probe to
 * discover: a fake token came back `NOT_FOUND — NotRegistered` and was kept.
 * `INVALID_ARGUMENT` covers one that was never valid, including a token issued by
 * a different push service before this app talked to FCM directly.
 *
 * Deliberately not `SENDER_ID_MISMATCH`: it means the token belongs to another
 * Firebase project, which is as likely to be a misconfigured server as a stale
 * token — and acting on it would empty the whole table on the first send.
 * Anything else may be transient, and deleting a token over a temporary fault
 * silently stops notifying somebody forever.
 */
const DEAD_TOKEN_ERRORS = new Set([
  'NOT_FOUND',
  'UNREGISTERED',
  'INVALID_ARGUMENT',
]);

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  /** Built on first use, so a `log` deployment needs no credentials at all. */
  private credentials?: { account: ServiceAccount; tokens: AccessTokenCache };

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

    let accessToken: string;
    let projectId: string;
    try {
      const { account, tokens } = this.resolveCredentials();
      accessToken = await tokens.get();
      projectId = account.project_id;
    } catch (cause) {
      // Bad or missing credentials are a deployment fault, not a delivery one:
      // said once, loudly, and no token is retired over it.
      this.logger.error(
        `Cannot authenticate with FCM: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return { retiredTokens: [] };
    }

    const retiredTokens: string[] = [];

    for (let index = 0; index < messages.length; index += CONCURRENCY) {
      const slice = messages.slice(index, index + CONCURRENCY);
      const outcomes = await Promise.all(
        slice.map((message) => this.sendOne(message, projectId, accessToken)),
      );
      retiredTokens.push(
        ...outcomes.filter((token): token is string => token !== null),
      );
    }

    return { retiredTokens };
  }

  /** Returns the token to retire, or `null` when there is nothing to act on. */
  private async sendOne(
    message: PushMessage,
    projectId: string,
    accessToken: string,
  ): Promise<string | null> {
    try {
      const response = await fetch(
        `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({ message: bodyFor(message) }),
        },
      );

      if (response.ok) return null;

      const payload = (await response.json().catch(() => null)) as {
        error?: { status?: string; message?: string };
      } | null;
      const status = payload?.error?.status ?? String(response.status);

      this.logger.warn(
        `Push rejected for ${message.to}: ${status}` +
          `${payload?.error?.message ? ` — ${payload.error.message}` : ''}`,
      );

      return DEAD_TOKEN_ERRORS.has(status) ? message.to : null;
    } catch (cause) {
      this.logger.error(
        `Could not reach FCM: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      return null;
    }
  }

  private resolveCredentials(): {
    account: ServiceAccount;
    tokens: AccessTokenCache;
  } {
    if (this.credentials) return this.credentials;

    const raw = this.config.get('FCM_SERVICE_ACCOUNT', { infer: true });
    // Boot already refuses `fcm` without this, so reaching here means the
    // configuration changed underneath a running process.
    if (!raw) throw new Error('FCM_SERVICE_ACCOUNT is not set.');

    const account = parseServiceAccount(raw);
    this.credentials = { account, tokens: new AccessTokenCache(account) };
    return this.credentials;
  }
}

/**
 * One message in FCM's v1 shape.
 *
 * `notification` rather than a data-only payload, so Android draws it while the
 * app is closed — which is the only reason any of this exists. The channel goes
 * in the Android block, and has to be one the app has created or the system
 * quietly falls back to a default with no sound.
 */
function bodyFor(message: PushMessage): Record<string, unknown> {
  return {
    token: message.to,
    notification: { title: message.title, body: message.body },
    android: {
      priority: 'high',
      notification: {
        ...(message.channelId ? { channel_id: message.channelId } : {}),
      },
    },
    // FCM data values must be strings, and the app reads them back as such.
    ...(message.data
      ? {
          data: Object.fromEntries(
            Object.entries(message.data).map(([key, value]) => [
              key,
              String(value),
            ]),
          ),
        }
      : {}),
  };
}
