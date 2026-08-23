import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WriteGradeDto } from './dto/write-grade.dto';
import { WriteJournalDto } from './dto/write-journal.dto';
import { GradebookService } from './gradebook.service';

/**
 * The gradebook, addressed by what each thing is about.
 *
 * No prefix, because these paths hang off two different parents — a lesson's
 * journal and a student's marks — and a controller prefix can only be one of
 * them.
 *
 * Nothing here is gated behind an addon. Recording what happened in a lesson and
 * marking a student's work is teaching, not administration: a tutor who can reach
 * the lesson can write it up. `MANAGE_STUDENTS` gates who exists, not who gets
 * a grade.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class GradebookController {
  constructor(private readonly gradebook: GradebookService) {}

  /**
   * `PATCH /lessons/:id/journal` — the whole write-up in one request.
   *
   * `PATCH` rather than `PUT` because omitting a field leaves it alone, which is
   * what lets the same endpoint serve one tap on attendance and a full write-up
   * later the same evening.
   */
  @Patch('lessons/:lessonId/journal')
  writeJournal(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
    @Body() dto: WriteJournalDto,
  ) {
    return this.gradebook.writeJournal(user, lessonId, dto);
  }

  /** The register for one lesson: who was marked, and how. */
  @Get('lessons/:lessonId/register')
  register(@CurrentUser() user: User, @Param('lessonId') lessonId: string) {
    return this.gradebook.registerFor(user, lessonId);
  }

  @Get('lessons/:lessonId/grades')
  listForLesson(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
  ) {
    return this.gradebook.listForLesson(user, lessonId);
  }

  @Post('lessons/:lessonId/grades')
  addForLesson(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
    @Body() dto: WriteGradeDto,
  ) {
    return this.gradebook.addForLesson(user, lessonId, dto);
  }

  @Get('students/:studentId/grades')
  listForStudent(
    @CurrentUser() user: User,
    @Param('studentId') studentId: string,
  ) {
    return this.gradebook.listForStudent(user, studentId);
  }

  /** A mark not tied to any lesson — a term test, an exam. */
  @Post('students/:studentId/grades')
  addForStudent(
    @CurrentUser() user: User,
    @Param('studentId') studentId: string,
    @Body() dto: WriteGradeDto,
  ) {
    return this.gradebook.addForStudent(user, studentId, dto);
  }

  /**
   * The headline numbers — averages, attendance rate, lesson counts.
   *
   * Its own endpoint rather than fields on the student: it is read by one card on
   * one screen, and putting it on the student row would make every roster request
   * pay for arithmetic nobody asked for.
   */
  @Get('students/:studentId/progress')
  progress(@CurrentUser() user: User, @Param('studentId') studentId: string) {
    return this.gradebook.progressForStudent(user, studentId);
  }

  /**
   * `PUT`, not `PATCH`: a correction replaces the mark whole, because changing
   * the kind changes which of its fields mean anything.
   */
  @Put('grades/:id')
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: WriteGradeDto,
  ) {
    return this.gradebook.update(user, id, dto);
  }

  @Delete('grades/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.gradebook.remove(user, id);
  }
}
