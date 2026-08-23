import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { AddonsService } from '../addons/addons.service';
import { SetAddonsDto } from '../addons/dto/set-addons.dto';
import { CreateTutorDto } from './dto/create-tutor.dto';
import { RegisterSchoolDto } from './dto/register-school.dto';
import { UpdateSchoolDto } from './dto/update-school.dto';
import { SchoolsService } from './schools.service';

@Controller('schools')
export class SchoolsController {
  constructor(
    private readonly schools: SchoolsService,
    private readonly addons: AddonsService,
  ) {}

  /**
   * Public: this is how a school comes into existence. Returns the app's
   * `Session`, so the new admin is signed in on success.
   */
  @Post('register')
  register(@Body() dto: RegisterSchoolDto) {
    return this.schools.register(dto);
  }

  @Get('current')
  @UseGuards(JwtAuthGuard)
  current(@CurrentUser() user: User) {
    return this.schools.findCurrent(user);
  }

  @Patch('current')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  update(@CurrentUser() user: User, @Body() dto: UpdateSchoolDto) {
    return this.schools.update(user, dto);
  }

  /** Any member may list colleagues — the calendar filters need them. */
  @Get('current/tutors')
  @UseGuards(JwtAuthGuard)
  tutors(@CurrentUser() user: User) {
    return this.schools.listTutors(user);
  }

  /**
   * Replaces a member's capabilities with the set submitted.
   *
   * Admin-only by role, not by addon: handing out permissions is the one thing
   * that must not itself be delegable, or the boundary means nothing.
   */
  @Patch('current/members/:userId/addons')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  setAddons(
    @CurrentUser() admin: User,
    @Param('userId') userId: string,
    @Body() dto: SetAddonsDto,
  ) {
    return this.addons.setFor(admin, userId, dto.addons);
  }

  @Post('current/tutors')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  createTutor(@CurrentUser() user: User, @Body() dto: CreateTutorDto) {
    return this.schools.createTutor(user, dto);
  }
}
