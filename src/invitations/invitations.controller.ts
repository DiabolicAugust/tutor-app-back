import {
  Body,
  Controller,
  Delete,
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
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InviteTutorDto } from './dto/invite-tutor.dto';
import { InvitationsService } from './invitations.service';
import {
  ThrottleInvitationLookup,
  ThrottleRegistration,
} from '../common/throttling';

/**
 * Two audiences in one resource: a member with the `INVITE_TUTORS` capability
 * managing invitations, and a stranger holding a link. The public routes are the
 * ones keyed by token — knowing the token *is* the authorisation.
 *
 * Gated on the capability rather than the admin role, so a school can delegate
 * hiring without handing over the school.
 */
@Controller('invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post()
  @UseGuards(JwtAuthGuard, AddonGuard)
  @RequiresAddon(AddonKey.INVITE_TUTORS)
  invite(@CurrentUser() admin: User, @Body() dto: InviteTutorDto) {
    return this.invitations.invite(admin, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, AddonGuard)
  @RequiresAddon(AddonKey.INVITE_TUTORS)
  list(@CurrentUser() admin: User) {
    return this.invitations.list(admin);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, AddonGuard)
  @RequiresAddon(AddonKey.INVITE_TUTORS)
  revoke(@CurrentUser() admin: User, @Param('id') id: string) {
    return this.invitations.revoke(admin, id);
  }

  /** Public: what the app shows on the invited registration form. */
  @Get('token/:token')
  @ThrottleInvitationLookup()
  describe(@Param('token') token: string) {
    return this.invitations.describe(token);
  }

  /** Public: creates the account and returns a session. */
  @Post('token/:token/accept')
  @ThrottleRegistration()
  accept(@Param('token') token: string, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(token, dto);
  }
}
