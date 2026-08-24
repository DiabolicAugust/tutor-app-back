import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { AddonKey } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequiresAddon } from '../common/decorators/requires-addon.decorator';
import { AddonGuard } from '../common/guards/addon.guard';
import { AnnounceDto } from './dto/announce.dto';
import { NotificationsService } from './notifications.service';
import { ThrottleBroadcast } from '../common/throttling';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.notifications.list(user);
  }

  @Post(':id/read')
  @HttpCode(HttpStatus.NO_CONTENT)
  markRead(@CurrentUser() user: User, @Param('id') id: string) {
    return this.notifications.markRead(user, id);
  }

  /**
   * Gated on the capability, not the role: a school may want a senior tutor to
   * be able to announce without making them an admin.
   */
  @Post('announcements')
  @ThrottleBroadcast()
  @UseGuards(JwtAuthGuard, AddonGuard)
  @RequiresAddon(AddonKey.BROADCAST_ANNOUNCEMENTS)
  announce(@CurrentUser() user: User, @Body() dto: AnnounceDto) {
    return this.notifications.announce(user, dto.text);
  }

  @Post('read-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  markAllRead(@CurrentUser() user: User) {
    return this.notifications.markAllRead(user);
  }
}
