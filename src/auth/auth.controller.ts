import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';

import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { User } from '../../generated/prisma/client';
import { AddonsService } from '../addons/addons.service';
import { AuthService, toAuthUser } from './auth.service';
import { SignInDto } from './dto/sign-in.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly addons: AddonsService,
  ) {}

  /** Returns the app's `Session` verbatim: `{ user, token, issuedAt }`. */
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  signIn(@Body() dto: SignInDto) {
    return this.auth.signIn(dto);
  }

  /** Lets a client with a stored token confirm it is still valid. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: User) {
    return toAuthUser(user, await this.addons.resolveFor(user));
  }
}
