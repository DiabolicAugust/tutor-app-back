import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateGroupDto {
  /** What the school calls it — "B1 Tuesdays", "Year 9 exam prep". */
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * What the group studies, as an id from the school's list.
   *
   * Required, as the free-text field it replaces was: a group is defined by its
   * subject, and one without it has nothing to prefill a booking with.
   */
  @IsString()
  @MinLength(1)
  subjectId!: string;

  /**
   * Free text rather than an enum: "B1", "Beginners", "Year 9" are all real
   * answers, and every school names levels its own way.
   */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  level?: string;
}

/** Every field optional — a client sends only what it is changing. */
export class UpdateGroupDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  subjectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  level?: string;
}

export class AddMemberDto {
  @IsString()
  studentId!: string;
}
