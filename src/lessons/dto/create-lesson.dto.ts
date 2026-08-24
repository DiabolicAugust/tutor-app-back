import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CreateLessonDto {
  /**
   * The student, for a one-to-one lesson.
   *
   * Exactly one of `studentId` and `groupId` must be sent; the service rejects
   * neither and both. Not expressed with `ValidateIf` because the rule is about
   * the pair rather than about either field, and a message naming both is the
   * one a caller can act on.
   */
  @IsOptional()
  @IsString()
  studentId?: string;

  /** The group, for a group lesson. */
  @IsOptional()
  @IsString()
  groupId?: string;

  /**
   * What is being taught, as an id from the school's subject list.
   *
   * Optional, because the free-text field it replaces accepted a blank and the
   * app showed such a lesson as simply "Lesson". Making it required here would
   * refuse bookings this app has always allowed; the form asks for one, which is
   * where that belongs.
   */
  @IsOptional()
  @IsString()
  subjectId?: string;

  /** ISO 8601 instant — the same format the app sends and stores. */
  @IsDateString()
  startsAt!: string;

  @IsInt()
  @Min(5)
  @Max(600)
  durationMinutes!: number;
}

export class ListLessonsQueryDto {
  /** Inclusive start of the window. Defaults to the start of today. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Exclusive end of the window. Defaults to 30 days after `from`. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /**
   * Comma-separated tutor ids to include — the app's calendar filters. Any id
   * outside the caller's school is ignored rather than rejected.
   */
  @IsOptional()
  @IsString()
  tutorIds?: string;
}
