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
import { ThrottleSignIn } from '../common/throttling';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly addons: AddonsService,
  ) {}

  /** Returns the app's `Session` verbatim: `{ user, token, issuedAt }`. */
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ThrottleSignIn()
  signIn(@Body() dto: SignInDto) {
    return this.auth.signIn(dto);
  }

  /**
   * Ends every session this account holds.
   *
   * A request rather than a purely client-side discard, which is what it was: a
   * token that is only forgotten by the app that held it is still a working key
   * for as long as it has left to live.
   */
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  signOut(@CurrentUser() user: User) {
    return this.auth.signOut(user);
  }

  /** Lets a client with a stored token confirm it is still valid. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: User) {
    return toAuthUser(user, await this.addons.resolveFor(user));
  }
}
