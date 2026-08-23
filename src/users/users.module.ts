import { Global, Module } from '@nestjs/common';

import { UsersController } from './users.controller';
import { UsersService } from './users.service';

/** Global: the auth module reads the config when issuing a session. */
@Global()
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
