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
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { StudentsService } from './students.service';

/**
 * Reading is open to any member: every screen that shows a lesson needs the
 * student's name, so gating the list would break the calendar for everyone.
 *
 * Writing needs `MANAGE_STUDENTS`. Two checks stack on those routes and they
 * answer different questions: the addon says *may this person edit students at
 * all*, and the service's ownership check says *may they edit this one*.
 */
@Controller('students')
@UseGuards(JwtAuthGuard)
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.students.findVisible(user);
  }

  @Get(':id')
  detail(@CurrentUser() user: User, @Param('id') id: string) {
    return this.students.findOne(user, id);
  }

  @Post()
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  create(@CurrentUser() user: User, @Body() dto: CreateStudentDto) {
    return this.students.create(user, dto);
  }

  @Patch(':id')
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  update(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateStudentDto,
  ) {
    return this.students.update(user, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AddonGuard)
  @RequiresAddon(AddonKey.MANAGE_STUDENTS)
  remove(@CurrentUser() user: User, @Param('id') id: string) {
    return this.students.remove(user, id);
  }
}
