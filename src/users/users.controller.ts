import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { UpdateUserConfigDto } from './dto/update-user-config.dto';
import { UsersService } from './users.service';

/** Everything scoped to "the caller" — no user ids in these paths. */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('config')
  config(@CurrentUser() user: User) {
    return this.users.getConfig(user);
  }

  @Patch('config')
  updateConfig(@CurrentUser() user: User, @Body() dto: UpdateUserConfigDto) {
    return this.users.updateConfig(user, dto);
  }
}
