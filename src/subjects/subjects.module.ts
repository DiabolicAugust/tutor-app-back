import { Module } from '@nestjs/common';

import { SubjectsController } from './subjects.controller';
import { SubjectsService } from './subjects.service';

/**
 * Exported, because the modules that create students, groups and lessons all
 * have to resolve a subject id against the caller's school before they store it
 * — and that rule belongs in one place rather than three.
 */
@Module({
  controllers: [SubjectsController],
  providers: [SubjectsService],
  exports: [SubjectsService],
})
export class SubjectsModule {}
