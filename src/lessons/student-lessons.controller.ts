import { Controller, Get, Param, UseGuards } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { LessonsService } from './lessons.service';

/**
 * A student's lesson history, at a path nested under the student.
 *
 * Its own controller with no prefix, because a method path cannot escape its
 * controller's — `@Controller('lessons')` would have produced
 * `/lessons/students/:id/lessons`. It lives in `LessonsModule` rather than
 * `StudentsModule` so the two modules do not have to import each other:
 * lessons already need students for the ownership check, and the reverse would
 * close the loop.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class StudentLessonsController {
  constructor(private readonly lessons: LessonsService) {}

  @Get('students/:studentId/lessons')
  list(@CurrentUser() user: User, @Param('studentId') studentId: string) {
    return this.lessons.findForStudent(user, studentId);
  }
}
