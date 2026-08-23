import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateSupportRequestDto } from './dto/create-support-request.dto';
import { SupportService } from './support.service';

@Controller('support')
@UseGuards(JwtAuthGuard)
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post()
  submit(@CurrentUser() user: User, @Body() dto: CreateSupportRequestDto) {
    return this.support.submit(user, dto.message);
  }

  @Get()
  list(@CurrentUser() user: User) {
    return this.support.list(user);
  }
}
