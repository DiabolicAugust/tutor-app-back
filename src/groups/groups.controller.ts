import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { AddonKey } from '../../generated/prisma/enums';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequiresAddon } from '../common/decorators/requires-addon.decorator';
import { AddonGuard } from '../common/guards/addon.guard';
import { AddMemberDto, CreateGroupDto, UpdateGroupDto } from './dto/group.dto';
import { GroupsService } from './groups.service';

/**
 * Groups, and who is in them.
 *
 * Reading is open to any member, for the same reason the student list is: the
 * calendar shows a group lesson by its group's name, so gating the list would
 * break the calendar.
 *
 * Writing needs `MANAGE_STUDENTS` rather than a capability of its own. Putting
 * students into groups *is* managing students — a separate addon would be a
 * second switch for one permission, and schools would have to find both.
 */
@Controller('groups')
@UseGuards(JwtAuthGuard)
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.groups.findVisible(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: User, @Param('id') id: string) {
    return this.groups.findOne(user, id);
  }

  @Post()
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  create(@CurrentUser() user: User, @Body() dto: CreateGroupDto) {
    return this.groups.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.groups.remove(user, id);
  }

  /** Returns the whole group, so the screen never has to merge two shapes. */
  @Post(':id/members')
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  addMember(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.groups.addMember(user, id, dto.studentId);
  }

  @Delete(':id/members/:studentId')
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  removeMember(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Param('studentId') studentId: string,
  ) {
    return this.groups.removeMember(user, id, studentId);
  }
}
