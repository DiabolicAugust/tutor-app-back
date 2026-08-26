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
import { SessionsService } from '@diabolicaugust/session-kit/nest';

import type { AuthUserPayload } from './auth.types';
import { AuthSessionMapper } from './user-store';
import { SignInDto } from './dto/sign-in.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { ThrottleSignIn } from '../common/throttling';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly sessions: SessionsService<User, AuthUserPayload>,
    private readonly mapper: AuthSessionMapper,
  ) {}

  /** Returns the app's `Session` verbatim: `{ user, token, issuedAt }`. */
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ThrottleSignIn()
  signIn(@Body() dto: SignInDto) {
    return this.sessions.signIn(dto.email, dto.password);
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
    return this.sessions.signOut(user);
  }

  /** Lets a client with a stored token confirm it is still valid. */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  me(@CurrentUser() user: User) {
    // The same mapping as a sign-in, so a client confirming a stored token gets
    // exactly what it was given when it signed in. Two mappings would drift.
    return this.mapper.toPayload(user);
  }
}
