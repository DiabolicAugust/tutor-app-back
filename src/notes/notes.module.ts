import { Module } from '@nestjs/common';

import { LessonsModule } from '../lessons/lessons.module';
import { StudentsModule } from '../students/students.module';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

/**
 * Imports both parent modules for the one thing it needs from each: the single
 * place that decides whether a caller may touch a given student, and the single
 * place that decides the same for a lesson. A note is reachable exactly when its
 * subject is, so this module owns no authorization rule of its own.
 */
@Module({
  imports: [StudentsModule, LessonsModule],
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
