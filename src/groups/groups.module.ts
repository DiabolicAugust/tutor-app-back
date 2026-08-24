import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { SubjectsModule } from '../subjects/subjects.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Imports each of the other two for one check it must not make itself: that a
 * student being added to a group is one this caller may touch, and that a
 * subject being assigned belongs to their school and is still offered.
 */
@Module({
  imports: [StudentsModule, SubjectsModule],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
