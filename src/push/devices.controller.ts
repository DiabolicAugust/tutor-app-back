import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { DevicesService } from './devices.service';
import { RegisterDeviceDto } from './dto/register-device.dto';

/** Scoped to the caller: there are no device ids in these paths. */
@Controller('users/me/devices')
@UseGuards(JwtAuthGuard)
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Post()
  @HttpCode(HttpStatus.NO_CONTENT)
  async register(@CurrentUser() user: User, @Body() dto: RegisterDeviceDto) {
    await this.devices.register(user, dto.token, dto.platform);
  }

  /**
   * Called on sign-out.
   *
   * A body on a DELETE, because the thing being deleted is identified by a token
   * too long and too full of punctuation to put in a path.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(@CurrentUser() user: User, @Body() dto: RegisterDeviceDto) {
    await this.devices.unregister(user, dto.token);
  }
}
