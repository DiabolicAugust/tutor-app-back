import { Module } from '@nestjs/common';

import { PushModule } from '../push/push.module';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Module({
  imports: [PushModule],
  controllers: [NotificationsController],
  providers: [NotificationsService],
  // Exported because joining a school is news, and the thing that knows somebody
  // has joined is `InvitationsModule`.
  exports: [NotificationsService],
})
export class NotificationsModule {}
