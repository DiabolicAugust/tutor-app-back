import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class ReportQueryDto {
  /** Inclusive start of the window. Defaults to 30 days before `to`. */
  @IsOptional()
  @IsDateString()
  from?: string;

  /** Exclusive end. Defaults to now. */
  @IsOptional()
  @IsDateString()
  to?: string;

  /**
   * Narrow a school report to one tutor.
   *
   * Admins only. A tutor sending somebody else's id is refused rather than
   * quietly given their own numbers back: a report that silently answers a
   * different question than the one asked is worse than an error.
   */
  @IsOptional()
  @IsString()
  tutorId?: string;
}

export class DebtorQueryDto {
  /**
   * Narrow to one tutor. Admins only, on the same rule as the summary.
   */
  @IsOptional()
  @IsString()
  tutorId?: string;

  /**
   * Include everybody at or below this balance. Zero by default — out of
   * lessons.
   *
   * Positive values are how a "running low" list would be asked for, which is
   * the same question one lesson earlier. Bounded so the parameter cannot be
   * used to ask for the whole roster: a large enough number would return every
   * student, which is a different screen with different permissions.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-100)
  @Max(10)
  atOrBelow?: number;
}
