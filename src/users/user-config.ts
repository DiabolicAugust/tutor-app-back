import { z } from 'zod';

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

const userConfigSchema = z.object({
  /**
   * Whether to send an automatic reminder before a lesson. Off by default: an
   * app that starts notifying without being asked is one people mute.
   */
  lessonReminders: z.boolean().default(false),
  /** How long before the lesson to send it. */
  lessonReminderMinutes: z.coerce.number().int().min(5).max(1440).default(30),
});

export type UserConfig = z.infer<typeof userConfigSchema>;

/** Every field optional — a client sends only what it is changing. */
export const userConfigPatchSchema = userConfigSchema.partial();

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
