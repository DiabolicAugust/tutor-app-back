import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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
}
