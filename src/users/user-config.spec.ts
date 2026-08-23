import {
  defaultUserConfig,
  mergeUserConfig,
  parseUserConfig,
  REMINDER_PRESETS_MINUTES,
} from './user-config';

describe('parseUserConfig', () => {
  it('fills in a complete config from nothing at all', () => {
    expect(parseUserConfig(undefined)).toEqual(defaultUserConfig);
    expect(parseUserConfig(null)).toEqual(defaultUserConfig);
    expect(parseUserConfig({})).toEqual(defaultUserConfig);
  });

  it('starts with reminders off', () => {
    expect(defaultUserConfig.lessonReminders).toBe(false);
  });

  it('keeps what it recognises', () => {
    expect(
      parseUserConfig({ lessonReminders: true, lessonReminderMinutes: 15 }),
    ).toEqual({
      lessonReminders: true,
      lessonReminderMinutes: 15,
      gradesEnabled: true,
    });
  });

  it('starts with grades on, because most tutors mark something', () => {
    expect(defaultUserConfig.gradesEnabled).toBe(true);
  });

  it('keeps grades switched off once somebody has switched them off', () => {
    // The one that matters: a default of `true` must not overwrite a stored
    // `false`, or the setting silently turns itself back on.
    expect(parseUserConfig({ gradesEnabled: false }).gradesEnabled).toBe(false);
  });

  it('falls back rather than throwing on a value of the wrong shape', () => {
    // A config an older build wrote must not make an account impossible to use.
    expect(parseUserConfig({ lessonReminders: 'yes' })).toEqual(
      defaultUserConfig,
    );
    expect(parseUserConfig('not an object')).toEqual(defaultUserConfig);
    expect(parseUserConfig(42)).toEqual(defaultUserConfig);
  });

  it('drops a setting the server no longer knows about', () => {
    expect(
      parseUserConfig({ lessonReminders: true, dailyDigest: true }),
    ).toEqual({ ...defaultUserConfig, lessonReminders: true });
  });

  it('rejects a reminder time outside the range a reminder makes sense in', () => {
    expect(parseUserConfig({ lessonReminderMinutes: 0 })).toEqual(
      defaultUserConfig,
    );
    expect(parseUserConfig({ lessonReminderMinutes: 10_000 })).toEqual(
      defaultUserConfig,
    );
  });

  it('accepts every preset the app offers', () => {
    for (const minutes of REMINDER_PRESETS_MINUTES) {
      expect(parseUserConfig({ lessonReminderMinutes: minutes })).toMatchObject(
        {
          lessonReminderMinutes: minutes,
        },
      );
    }
  });
});

describe('mergeUserConfig', () => {
  it('changes only what the patch names', () => {
    expect(
      mergeUserConfig(
        { lessonReminders: true, lessonReminderMinutes: 60 },
        { lessonReminderMinutes: 15 },
      ),
    ).toEqual({
      ...defaultUserConfig,
      lessonReminders: true,
      lessonReminderMinutes: 15,
    });
  });

  it('ignores keys explicitly set to undefined', () => {
    // A validated DTO carries an own property for every field it declares, so
    // this is the ordinary case rather than an odd one.
    expect(
      mergeUserConfig(
        { lessonReminders: true, lessonReminderMinutes: 60 },
        { lessonReminders: undefined, lessonReminderMinutes: 15 },
      ),
    ).toEqual({
      ...defaultUserConfig,
      lessonReminders: true,
      lessonReminderMinutes: 15,
    });
  });

  it('switches grades off without disturbing the rest', () => {
    expect(
      mergeUserConfig(
        { lessonReminders: true, lessonReminderMinutes: 60 },
        { gradesEnabled: false },
      ),
    ).toEqual({
      lessonReminders: true,
      lessonReminderMinutes: 60,
      gradesEnabled: false,
    });
  });

  it('returns a complete config even from an empty patch', () => {
    expect(mergeUserConfig(undefined, {})).toEqual(defaultUserConfig);
  });
});
