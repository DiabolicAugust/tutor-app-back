import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/** Every field optional — a client sends only what it is changing. */
export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  /**
   * An id moves the student to that subject; an explicit `null` clears it.
   *
   * `@IsOptional()` lets both `undefined` and `null` through, which is what
   * makes the difference between "not mentioned" and "cleared" expressible at
   * all — the service reads it, and only a sent `null` blanks the field.
   */
  @IsOptional()
  @IsString()
  subjectId?: string | null;

  /**
   * Adjusting the balance by hand — what a tutor does after taking payment.
   * Never negative: a package that has run out is zero, not debt.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  paidLessonsLeft?: number;
}
