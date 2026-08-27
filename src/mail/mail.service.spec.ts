import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { Env } from '../config/env';
import { MailService } from './mail.service';

/** A config that answers with whatever the test put in the map. */
const configWith = (values: Partial<Env>) =>
  ({ get: (key: keyof Env) => values[key] }) as unknown as ConfigService<
    Env,
    true
  >;

const anInvitation = {
  to: 'newcomer@example.test',
  schoolName: 'Fox Academy',
  invitedByName: 'Olha',
  acceptUrl: 'foxacademy://invite/secret-token',
  expiresAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('MailService with the log transport', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message) => {
      logged.push(String(message));
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const service = () =>
    new MailService(
      configWith({
        MAIL_TRANSPORT: 'log',
        SUPPORT_EMAIL: 'support@example.test',
      }),
    );

  it('writes the invitation link, which is what makes the flow testable', async () => {
    await service().sendInvitation(anInvitation);

    // Deliberate: in development the alternative is a feature nobody can try.
    expect(logged.join('\n')).toContain('foxacademy://invite/secret-token');
    expect(logged.join('\n')).toContain('newcomer@example.test');
  });

  it('writes a support request to wherever support is configured', async () => {
    await service().sendSupportRequest({
      requestId: 'req-1',
      fromName: 'Anna',
      fromEmail: 'anna@example.test',
      schoolId: 'school-1',
      message: 'The calendar is showing the wrong week.',
    });

    expect(logged.join('\n')).toContain('support@example.test');
    expect(logged.join('\n')).toContain(
      'The calendar is showing the wrong week.',
    );
  });

  it('sends nothing at all', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');

    await service().sendInvitation(anInvitation);

    // The point of this transport. A development machine that quietly mailed a
    // real address would be worse than one that mailed nothing.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * The provider transport, driven against a stand-in for its HTTP API.
 *
 * `fetch` is mocked rather than an SDK, because there is no SDK: the request is
 * this service's own, and a renamed field is exactly what would break silently.
 * What is asserted is the contract Resend documents — the endpoint, the bearer
 * key, the `from` — plus the two failure behaviours that matter more than any of
 * it.
 */
describe('MailService with the resend transport', () => {
  const service = () =>
    new MailService(
      configWith({
        MAIL_TRANSPORT: 'resend',
        RESEND_API_KEY: 're_test_key',
        MAIL_FROM: 'Fox Academy <invites@foxacademy.test>',
        SUPPORT_EMAIL: 'support@example.test',
      }),
    );

  /**
   * One recorded request, already narrowed.
   *
   * `fetch`'s own parameter types admit a `Request` object and a streaming body,
   * neither of which this service ever produces. Narrowing at the point of
   * capture keeps the assertions plain strings instead of casts.
   */
  type Call = {
    url: string;
    method?: string;
    headers: Record<string, string>;
    body: string;
  };

  const urlOf = (url: RequestInfo | URL): string =>
    typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;

  /** Replaces `fetch` and records what it was asked to send. */
  const stubFetch = (response: {
    ok: boolean;
    status?: number;
    body?: string;
  }): Call[] => {
    const calls: Call[] = [];

    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: urlOf(url),
          method: init?.method,
          headers: (init?.headers ?? {}) as Record<string, string>,
          body: typeof init?.body === 'string' ? init.body : '',
        });
        return Promise.resolve({
          ok: response.ok,
          status: response.status ?? (response.ok ? 200 : 422),
          text: () => Promise.resolve(response.body ?? ''),
        } as Response);
      });

    return calls;
  };

  afterEach(() => jest.restoreAllMocks());

  const sentBody = (calls: Call[]) =>
    JSON.parse(calls[0].body) as {
      from: string;
      to: string[];
      subject: string;
      text: string;
    };

  it('posts the message to the provider, signed with the key', async () => {
    const calls = stubFetch({ ok: true });

    await service().sendInvitation(anInvitation);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers.Authorization).toBe('Bearer re_test_key');
  });

  it('sends from the configured address to the invited one', async () => {
    const calls = stubFetch({ ok: true });

    await service().sendInvitation(anInvitation);
    const body = sentBody(calls);

    // `to` is an array because the API takes one. A bare string works today and
    // stops working the day somebody adds a second recipient.
    expect(body.to).toEqual(['newcomer@example.test']);
    expect(body.from).toBe('Fox Academy <invites@foxacademy.test>');
  });

  it('carries the link and who is inviting, since that is the whole message', async () => {
    const calls = stubFetch({ ok: true });

    await service().sendInvitation(anInvitation);
    const body = sentBody(calls);

    expect(body.subject).toContain('Olha');
    expect(body.subject).toContain('Fox Academy');
    expect(body.text).toContain('foxacademy://invite/secret-token');
  });

  it('sends a support request to the support address, not to the requester', async () => {
    const calls = stubFetch({ ok: true });

    await service().sendSupportRequest({
      requestId: 'req-1',
      fromName: 'Anna',
      fromEmail: 'anna@example.test',
      schoolId: 'school-1',
      message: 'Anything at all.',
    });
    const body = sentBody(calls);

    // Reversing these two would mail the support queue's contents to whoever
    // wrote in, which is a data leak wearing the costume of a reply.
    expect(body.to).toEqual(['support@example.test']);
    expect(body.text).toContain('anna@example.test');
  });

  it('fails loudly, repeating what the provider said', async () => {
    stubFetch({
      ok: false,
      status: 403,
      body: '{"message":"The foxacademy.test domain is not verified."}',
    });

    // The provider's own words: "not verified" and "invalid key" need different
    // fixes, and a generic message sends somebody looking in the wrong place.
    // This is the commonest first failure of all.
    await expect(service().sendInvitation(anInvitation)).rejects.toThrow(
      /not verified/,
    );
  });

  it('names the recipient in the failure but never the link', async () => {
    stubFetch({ ok: false, status: 500, body: 'upstream exploded' });

    const error = await service()
      .sendInvitation(anInvitation)
      .catch((cause: Error) => cause.message);

    expect(error).toContain('newcomer@example.test');
    // The token grants access to a school, and errors are copied into chat
    // messages and issue trackers. The address is enough to act on.
    expect(error).not.toContain('secret-token');
  });
});
