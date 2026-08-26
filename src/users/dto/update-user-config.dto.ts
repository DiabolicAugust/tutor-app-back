import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

import type { UserConfigPatch } from '../user-config';

/**
 * Mirrors `userConfigPatchSchema` for Nest's validation pipe, which works off
 * decorators. The zod schema stays the authority on what gets persisted — this
 * rejects obvious nonsense before it reaches the service.
 */
export class UpdateUserConfigDto {
  @IsOptional()
  @IsBoolean()
  lessonReminders?: boolean;

  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(1440)
  lessonReminderMinutes?: number;

  @IsOptional()
  @IsBoolean()
  gradesEnabled?: boolean;

  /**
   * Where this tutor teaches online, or null to teach in a room.
   *
   * Checked no further than "it is an object" here. What makes a meeting room
   * acceptable — the provider it belongs to, the host it is on, https — is one
   * rule with one owner, `meetingRoomProblem`, and the service runs the zod
   * schema that applies it. Restating any of that in decorators would be a
   * second copy to disagree with the first.
   */
  @IsOptional()
  @IsObject()
  meeting?: UserConfigPatch['meeting'];
}
