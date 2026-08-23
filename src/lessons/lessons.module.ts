import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { LessonsController } from './lessons.controller';
import { LessonsService } from './lessons.service';

@Module({
  imports: [StudentsModule],
  controllers: [LessonsController],
  providers: [LessonsService],
})
export class LessonsModule {}
