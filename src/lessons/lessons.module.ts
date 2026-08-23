import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';
import { StudentLessonsController } from './student-lessons.controller';

@Module({
  imports: [StudentsModule],
  controllers: [LessonsController, StudentLessonsController],
  providers: [LessonsService],
  exports: [LessonsService],
})
export class LessonsModule {}
