import { Module } from '@nestjs/common';

import { StudentsModule } from '../students/students.module';
import { GroupsController } from './groups.controller';
import { GroupsService } from './groups.service';

/**
 * Imports `StudentsModule` for the one thing it needs: proof that a student a
 * caller is adding to a group is a student that caller may touch.
 */
@Module({
  imports: [StudentsModule],
  controllers: [GroupsController],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
