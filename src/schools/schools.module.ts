import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { SchoolsController } from './schools.controller';
import { SchoolsService } from './schools.service';

@Module({
  // Registration signs the new admin in, which is the auth module's job.
  imports: [AuthModule],
  controllers: [SchoolsController],
  providers: [SchoolsService],
})
export class SchoolsModule {}
