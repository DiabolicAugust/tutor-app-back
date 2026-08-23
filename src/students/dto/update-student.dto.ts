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

  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string;

  /**
   * Adjusting the balance by hand — what a tutor does after taking payment.
   * Never negative: a package that has run out is zero, not debt.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  paidLessonsLeft?: number;
}
