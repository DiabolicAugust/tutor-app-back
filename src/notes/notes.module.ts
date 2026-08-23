import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { NotesController } from './notes.controller';
import { NotesService } from './notes.service';

/**
 * Imports `StudentsModule` for the one thing it needs from it: the single place
 * that decides whether a caller may touch a given student.
 */
@Module({
  imports: [StudentsModule],
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
