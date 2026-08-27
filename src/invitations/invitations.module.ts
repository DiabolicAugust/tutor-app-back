import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { InvitationsController } from './invitations.controller';
import { InvitePageController } from './invite-page.controller';
import { InvitationsService } from './invitations.service';

@Module({
  // Accepting an invitation signs the new tutor in.
  imports: [AuthModule, NotificationsModule],
  controllers: [InvitationsController, InvitePageController],
  providers: [InvitationsService],
})
export class InvitationsModule {}
