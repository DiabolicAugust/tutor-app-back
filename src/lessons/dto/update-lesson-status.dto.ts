import { IsIn } from 'class-validator';

import { LessonStatus } from '../../../generated/prisma/enums';

/**
 * Confirming a lesson after the fact — what the app's news feed does when the
 * tutor answers "did this take place?".
 */
export class UpdateLessonStatusDto {
  @IsIn([
    LessonStatus.COMPLETED,
    LessonStatus.CANCELLED,
    LessonStatus.SCHEDULED,
  ])
  status!: LessonStatus;
}
