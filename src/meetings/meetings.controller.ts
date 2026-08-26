import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';

import type { User } from '../../generated/prisma/client';
import { MeetingProvider } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { Env } from '../config/env';
import { MeetingAccountsService } from './meeting-accounts.service';
import { isConnectable } from './oauth-providers';

/**
 * Connecting a tutor's Zoom or Google account, so lessons can be given a room of
 * their own.
 *
 * The callback is the one route here that is **not** behind the guard, and
 * cannot be: it is opened by the provider's redirect in a browser, which carries
 * no token of ours. Who is connecting travels in a signed state instead — see
 * `authorizeUrlFor`.
 */
@Controller('meetings')
export class MeetingsController {
  constructor(
    private readonly accounts: MeetingAccountsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** What this server offers, and what this tutor has already connected. */
  @Get('connections')
  @UseGuards(JwtAuthGuard)
  async connections(@CurrentUser() user: User) {
    return {
      available: this.accounts.availableProviders(),
      connected: await this.accounts.connectionsFor(user),
    };
  }

  @Post('connect/:provider')
  @UseGuards(JwtAuthGuard)
  connect(@CurrentUser() user: User, @Param('provider') provider: string) {
    return {
      authorizeUrl: this.accounts.authorizeUrlFor(user, parse(provider)),
    };
  }

  @Delete('connect/:provider')
  @UseGuards(JwtAuthGuard)
  async disconnect(
    @CurrentUser() user: User,
    @Param('provider') provider: string,
  ) {
    await this.accounts.disconnect(user, parse(provider));
    return { disconnected: provider };
  }

  /**
   * Where the provider sends the browser back.
   *
   * Always a redirect into the app, success or failure, with the outcome as a
   * query parameter. A person who has just approved something in a browser tab
   * should end up back in Settings, not looking at a page of JSON from an API —
   * and on a failure they should end up somewhere that can say what to do next.
   */
  @Get('callback/:provider')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Res() response: Response,
  ) {
    const target = this.config.get('MEETING_CONNECTED_URL', { infer: true });

    if (error || !code || !state) {
      // `error` is what a provider sends when somebody presses Cancel, which is
      // not a fault and should not read like one.
      return response.redirect(
        `${target}?meeting=${provider}&status=cancelled`,
      );
    }

    try {
      await this.accounts.completeConnection(parse(provider), code, state);
      return response.redirect(
        `${target}?meeting=${provider}&status=connected`,
      );
    } catch {
      return response.redirect(`${target}?meeting=${provider}&status=failed`);
    }
  }
}

/** A provider name from a URL, or a 400 — never an unchecked cast. */
function parse(provider: string): MeetingProvider {
  const candidate = provider as MeetingProvider;
  if (!isConnectable(candidate)) {
    throw new BadRequestException('Unknown meeting provider');
  }

  return candidate;
}
