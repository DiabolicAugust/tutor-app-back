import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateLessonDto {
  @IsString()
  studentId!: string;

  @IsString()
  @MaxLength(120)
  subject!: string;

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
