import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { UserRole } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';
import { SubjectsService } from './subjects.service';

/**
 * The school's subject list.
 *
 * Reading is open to every member, because every form that books a lesson or
 * takes on a student needs something to offer. Changing it is admin-only: the
 * list is what keeps a school's records consistent, and a school where anyone
 * can add to it drifts back into free text one typo at a time.
 */
@Controller('subjects')
@UseGuards(JwtAuthGuard)
export class SubjectsController {
  constructor(private readonly subjects: SubjectsService) {}

  @Get()
  list(
    @CurrentUser() user: User,
    @Query('includeHidden') includeHidden?: string,
  ) {
    // A query string, so anything but an explicit "true" means the visible list.
    return this.subjects.list(user, includeHidden === 'true');
  }

  @Post()
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  create(@CurrentUser() user: User, @Body() dto: CreateSubjectDto) {
    return this.subjects.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  rename(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateSubjectDto,
  ) {
    return this.subjects.rename(user, id, dto);
  }

  /**
   * What still studies this subject.
   *
   * Its own endpoint, and not only the body of the 409 below, so the app can ask
   * *before* offering to hide — the admin sees what has to be moved as a list of
   * names, rather than finding out by being refused.
   */
  @Get(':id/usage')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  usage(@CurrentUser() user: User, @Param('id') id: string) {
    return this.subjects.usage(user, id);
  }

  /**
   * `POST .../hide` rather than `DELETE`, because nothing is deleted and the verb
   * should not suggest otherwise. Old lessons keep their subject and keep
   * reading; it simply stops being offered.
   */
  @Post(':id/hide')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  hide(@CurrentUser() user: User, @Param('id') id: string) {
    return this.subjects.hide(user, id);
  }

  @Post(':id/restore')
  @UseGuards(RolesGuard)
  @Roles(UserRole.ADMIN)
  restore(@CurrentUser() user: User, @Param('id') id: string) {
    return this.subjects.restore(user, id);
  }
}
