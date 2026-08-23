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
    await service().sendInvitation({
      to: 'newcomer@example.test',
      schoolName: 'Fox Academy',
      invitedByName: 'Olha',
      acceptUrl: 'foxacademy://invite/secret-token',
      expiresAt: new Date('2026-01-01T00:00:00.000Z'),
    });

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
});

describe('MailService with no provider', () => {
  const service = new MailService(
    configWith({
      MAIL_TRANSPORT: 'smtp' as never,
      SUPPORT_EMAIL: 'support@example.test',
    }),
  );

  it('rejects rather than pretending an invitation went out', async () => {
    await expect(
      service.sendInvitation({
        to: 'newcomer@example.test',
        schoolName: 'Fox Academy',
        invitedByName: 'Olha',
        acceptUrl: 'foxacademy://invite/token',
        expiresAt: new Date(),
      }),
    ).rejects.toThrow(/No mail provider/);
  });

  it('rejects a support notification too, so the caller can record the failure', async () => {
    await expect(
      service.sendSupportRequest({
        requestId: 'req-1',
        fromName: 'Anna',
        fromEmail: 'anna@example.test',
        schoolId: 'school-1',
        message: 'Anything at all.',
      }),
    ).rejects.toThrow(/No mail provider/);
  });
});
