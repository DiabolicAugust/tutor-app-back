import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import {
  MeetingAccountsService,
  MEETING_ENDPOINTS,
} from './meeting-accounts.service';
import { MeetingsController } from './meetings.controller';
import { DEFAULT_ENDPOINTS } from './oauth-providers';

/**
 * `AuthModule` for its `JwtModule`: the signed `state` that carries who is
 * connecting through a browser redirect is signed with the same secret as
 * everything else, so there is one key to keep rather than two.
 *
 * `MEETING_ENDPOINTS` is a provider rather than a constant import so a test can
 * point the whole exchange at a server it controls — which is the only way to
 * exercise Zoom and Google without somebody's real account.
 */
@Module({
  imports: [AuthModule],
  controllers: [MeetingsController],
  providers: [
    MeetingAccountsService,
    { provide: MEETING_ENDPOINTS, useValue: DEFAULT_ENDPOINTS },
  ],
  exports: [MeetingAccountsService],
})
export class MeetingsModule {}
