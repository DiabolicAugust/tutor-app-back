import { IsDateString, IsOptional, IsString } from 'class-validator';

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
