import { IsString, MaxLength, MinLength } from 'class-validator';

export class CreateSubjectDto {
  /**
   * What the school calls it — "Mathematics", "English", "Piano".
   *
   * Trimmed and compared case-insensitively by the service, because "algebra"
   * and "Algebra" arriving as two subjects is the exact confusion this whole
   * model exists to end.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}

/** Renaming is the only edit. Hiding and restoring are their own endpoints. */
export class UpdateSubjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;
}
