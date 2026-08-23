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

  @IsString()
  @MaxLength(120)
  subject!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  paidLessonsLeft?: number;
}
