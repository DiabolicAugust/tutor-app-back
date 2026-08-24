import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateStudentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  /**
   * What they usually study, as an id from the school's subject list.
   *
   * Optional, exactly as the free-text field it replaces was: a student can be
   * taken on before anybody has settled what they are studying, and refusing
   * that now would be a new rule smuggled in with a change of shape.
   */
  @IsOptional()
  @IsString()
  subjectId?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  paidLessonsLeft?: number;
}
