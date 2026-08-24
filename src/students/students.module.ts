import { Module } from '@nestjs/common';

import { SubjectsModule } from '../subjects/subjects.module';
import { StudentsController } from './students.controller';
import { StudentsService } from './students.service';

/**
 * Imports `SubjectsModule` for the one thing it needs: the single place that
 * decides whether a subject id belongs to the caller's school and is still
 * offered. Three modules store a subject, so that check lives in one.
 */
@Module({
  imports: [SubjectsModule],
  controllers: [StudentsController],
  providers: [StudentsService],
  exports: [StudentsService],
})
export class StudentsModule {}
