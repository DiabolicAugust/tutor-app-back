import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { WriteNoteDto } from './dto/note.dto';
import { NotesService } from './notes.service';

/**
 * Notes, addressed by what they are about.
 *
 * Nested under the subject rather than a flat `/notes?studentId=…`, because a
 * note only exists in relation to something and the URL is where that belongs.
 * Reading and writing are open to any member who can reach the subject: writing
 * a note is part of teaching, not an administrative capability.
 */
@Controller()
@UseGuards(JwtAuthGuard)
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get('students/:studentId/notes')
  listForStudent(
    @CurrentUser() user: User,
    @Param('studentId') studentId: string,
  ) {
    return this.notes.listForStudent(user, studentId);
  }

  @Post('students/:studentId/notes')
  addForStudent(
    @CurrentUser() user: User,
    @Param('studentId') studentId: string,
    @Body() dto: WriteNoteDto,
  ) {
    return this.notes.addForStudent(user, studentId, dto.text);
  }

  @Get('lessons/:lessonId/notes')
  listForLesson(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
  ) {
    return this.notes.listForLesson(user, lessonId);
  }

  @Post('lessons/:lessonId/notes')
  addForLesson(
    @CurrentUser() user: User,
    @Param('lessonId') lessonId: string,
    @Body() dto: WriteNoteDto,
  ) {
    return this.notes.addForLesson(user, lessonId, dto.text);
  }

  /** Flat, because by this point the note is the thing being addressed. */
  @Delete('notes/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notes.remove(user, id);
  }
}
