import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';

import {
  AttendanceStatus,
  LessonStatus,
} from '../../../generated/prisma/enums';

/** One student's line in the register. */
export class MarkAttendanceDto {
  @IsString()
  studentId!: string;

  @IsIn(Object.values(AttendanceStatus))
  status!: AttendanceStatus;

  /**
   * Whether this student's homework came back done.
   *
   * Per-student while the homework *text* is per-lesson, because that is how it
   * works: one assignment is set for the room, and each person either did it or
   * did not. Omitted leaves it alone, which is how "not checked yet" survives
   * marking attendance.
   */
  @IsOptional()
  @IsBoolean()
  homeworkDone?: boolean;
}

/**
 * Writing up a lesson: what was covered, what was set, who turned up.
 *
 * One payload rather than three endpoints, because it is one action. The whole
 * reason a tutor uses a phone for this is that the lesson has just ended and
 * they have a minute — three round trips and three chances to half-save is the
 * version that gets abandoned. For a group that matters more, not less: the
 * register is one screen and should be one save.
 *
 * Every field is optional and only the ones present are written, so the same
 * endpoint serves "mark the register now, write the topic tonight".
 */
export class WriteJournalDto {
  /** What was covered. An empty string clears it. Shared by the whole room. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  topic?: string;

  /** What was set for next time. An empty string clears it. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  homework?: string;

  /**
   * The register: one entry per student being marked.
   *
   * A list even for a one-to-one lesson, so there is one shape rather than two —
   * a caller that special-cased the individual case would be a second code path
   * to keep in step for no gain.
   *
   * Marking somebody also settles their balance and the lesson's status; see
   * `GradebookService.writeJournal`.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MarkAttendanceDto)
  attendance?: MarkAttendanceDto[];

  /** Overrides the status the register would otherwise imply. */
  @IsOptional()
  @IsIn(Object.values(LessonStatus))
  status?: LessonStatus;
}
