import { Module } from '@nestjs/common';

import { MeetingsModule } from '../meetings/meetings.module';
import { StudentsModule } from '../students/students.module';
import { SubjectsModule } from '../subjects/subjects.module';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { StudentLessonsController } from './student-lessons.controller';

@Module({
  imports: [StudentsModule, SubjectsModule, MeetingsModule],
  controllers: [LessonsController, StudentLessonsController],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
