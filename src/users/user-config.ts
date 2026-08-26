import { z } from 'zod';

import { MeetingProvider } from '../../generated/prisma/enums';
import { meetingRoomProblem } from '../meetings/meeting-providers';

/**
 * Per-user preferences, stored in the `users.config` JSON column.
 *
 * Validated here rather than in the schema so adding a preference needs no
 * migration — but *never* trusted as-is: a column written by an older build can
 * hold anything, so every read goes through `parseUserConfig`, which fills in
 * defaults and drops what it does not recognise.
 */

/** Offered as presets in the app; an arbitrary value in range is still valid. */
export const REMINDER_PRESETS_MINUTES = [15, 30, 60, 120] as const;

/**
 * Where this tutor teaches online, if they do.
 *
 * One object rather than two loose fields, so that "a provider with no room" and
 * "a room belonging to no provider" cannot be stored at all. Null means lessons
 * are taught in a room, which stays the default.
 */
const meetingConfigSchema = z
  .object({
    provider: z.enum(MeetingProvider),
    /**
     * The tutor's own meeting room, for providers that reuse one. Null for
     * providers that create a room per lesson.
     */
    roomUrl: z.string().max(500).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    const problem = meetingRoomProblem(value.provider, value.roomUrl);
    if (problem !== null) {
      ctx.addIssue({ code: 'custom', message: problem, path: ['roomUrl'] });
    }
  });

export type MeetingConfig = z.infer<typeof meetingConfigSchema>;

/**
 * What each preference has to look like, with no opinion about what it starts
 * as.
 *
 * Separate from the defaults below, and that separation is load-bearing rather
 * than tidiness. A patch is built by making these optional, and a field that
 * carried its own `.default()` would survive `.partial()` and be filled in for a
 * client that never sent it — so "change the reminder time" would also switch
 * reminders off, which is exactly the bug this shape prevents.
 */
const fieldTypes = {
  /** Whether to send an automatic reminder before a lesson. */
  lessonReminders: z.boolean(),
  /** How long before the lesson to send it. */
  lessonReminderMinutes: z.coerce.number().int().min(5).max(1440),
  /**
   * Whether this tutor marks work at all.
   *
   * On by default, and a *display* preference rather than a permission: turning
   * it off hides marks and averages from this person's app, and does not touch
   * what is stored. A tutor who never grades should not have to look past an
   * empty gradebook on every student, and a tutor who switches it back on must
   * find their history intact.
   *
   * Lives here rather than on the school, because two tutors in one school
   * genuinely differ: conversation practice has nothing to mark, exam prep is
   * mostly marking.
   */
  gradesEnabled: z.boolean(),
  /** Where this tutor teaches online, or null for a room. */
  meeting: meetingConfigSchema.nullable(),
};

/**
 * What each preference is before anybody has chosen.
 *
 * Reminders off: an app that starts notifying without being asked is one people
 * mute. Grading on: the gradebook is why most schools want a system at all, and
 * a feature nobody can find is worse than one somebody switches off. No meeting:
 * teaching in a room is still the ordinary case.
 */
const fieldDefaults = {
  lessonReminders: false,
  lessonReminderMinutes: 30,
  gradesEnabled: true,
  meeting: null,
} as const;

/**
 * What a read produces. The meeting block falls back to "no meeting" rather than
 * failing, because a column written by an older build — or by one that allowed a
 * host this build does not — must not cost somebody their reminder and grading
 * settings as collateral.
 */
const userConfigSchema = z.object({
  lessonReminders: fieldTypes.lessonReminders.default(
    fieldDefaults.lessonReminders,
  ),
  lessonReminderMinutes: fieldTypes.lessonReminderMinutes.default(
    fieldDefaults.lessonReminderMinutes,
  ),
  gradesEnabled: fieldTypes.gradesEnabled.default(fieldDefaults.gradesEnabled),
  meeting: fieldTypes.meeting
    .catch(fieldDefaults.meeting)
    .default(fieldDefaults.meeting),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

/**
 * What a write must satisfy. Deliberately strict where the read is lenient: a
 * request carrying an unusable meeting room is a mistake worth reporting, and
 * quietly storing "no meeting" instead would look like the setting had saved.
 *
 * Every field optional — a client sends only what it is changing. `meeting: null`
 * is how somebody goes back to teaching in a room, and is distinct from omitting
 * the field, which changes nothing.
 */
export const userConfigPatchSchema = z.object(fieldTypes).partial();

export type UserConfigPatch = z.infer<typeof userConfigPatchSchema>;

export const defaultUserConfig: UserConfig = userConfigSchema.parse({});

/**
 * Turns whatever is in the column into a complete, valid config.
 *
 * Falls back to defaults rather than throwing: a malformed config should not
 * make an account impossible to sign into.
 */
export function parseUserConfig(raw: unknown): UserConfig {
  const result = userConfigSchema.safeParse(raw ?? {});
  return result.success ? result.data : defaultUserConfig;
}

/**
 * Applies a patch on top of the stored config.
 *
 * Keys whose value is `undefined` are dropped before merging, and that is the
 * whole point of this function. A validated DTO carries an own property for
 * every field it declares, `undefined` included, so a plain spread would write
 * `undefined` over a setting the request never mentioned — turning "change the
 * reminder time" into "change the time and switch reminders off".
 */
export function mergeUserConfig(
  raw: unknown,
  patch: UserConfigPatch,
): UserConfig {
  const changes = Object.fromEntries(
    Object.entries(patch).filter(([, value]) => value !== undefined),
  );

  return { ...parseUserConfig(raw), ...changes };
}
