import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

import { GradeKind } from '../../../generated/prisma/enums';

/**
 * A mark.
 *
 * `value` is required for the two numeric kinds and rejected for the descriptive
 * one, expressed with `ValidateIf` rather than three DTO classes: the client
 * sends one shape and the discriminator is a field on it, so splitting the type
 * would mean the caller picking an endpoint by a value it already sent.
 *
 * The upper bound on a `CLASSIC` value cannot be checked here — it is the
 * school's scale, and this class cannot see the school. `GradebookService` does
 * it; this is the part that can be checked without a query.
 */
export class WriteGradeDto {
  /**
   * Who the mark is for.
   *
   * Only meaningful when marking from inside a **group** lesson, where the
   * lesson alone cannot say: required there, and rejected on a one-to-one lesson
   * whose single student would be the only valid answer anyway. Absent entirely
   * when marking from the student's own page.
   */
  @IsOptional()
  @IsString()
  studentId?: string;

  @IsIn(Object.values(GradeKind))
  kind!: GradeKind;

  /** Required unless the mark is descriptive; ignored if it is. */
  @ValidateIf((dto: WriteGradeDto) => dto.kind !== GradeKind.DESCRIPTIVE)
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  value?: number;

  /** "speaking", "homework", "unit 3 test" — whatever the school calls it. */
  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  /**
   * The words. Required for a descriptive mark, because a descriptive mark with
   * no words is not a mark at all; optional as a remark on a numeric one.
   */
  @ValidateIf((dto: WriteGradeDto) => dto.kind === GradeKind.DESCRIPTIVE)
  @IsString()
  @MaxLength(2000)
  comment?: string;

  /** How much it counts. Capped low: a weight of 100 is a typo, not a policy. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  weight?: number;
}
