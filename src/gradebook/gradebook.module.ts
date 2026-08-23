import { Module } from '@nestjs/common';

import { LessonsModule } from '../lessons/lessons.module';
import { StudentsModule } from '../students/students.module';
import { GradebookController } from './gradebook.controller';
import { GradebookService } from './gradebook.service';

/**
 * Imports both parents for the same reason `NotesModule` does: the gradebook
 * hangs off students and lessons, and the question of who may touch either is
 * already answered by the module that owns it.
 */
@Module({
  imports: [StudentsModule, LessonsModule],
  controllers: [GradebookController],
  providers: [GradebookService],
  exports: [GradebookService],
})
export class GradebookModule {}
