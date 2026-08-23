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
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CreateLessonDto, ListLessonsQueryDto } from './dto/create-lesson.dto';
import { UpdateLessonStatusDto } from './dto/update-lesson-status.dto';
import { LessonsService } from './lessons.service';

@Controller('lessons')
@UseGuards(JwtAuthGuard)
export class LessonsController {
  constructor(private readonly lessons: LessonsService) {}

  /** `GET /lessons?from=…&to=…&tutorIds=me,tutor-2` — one call per calendar view. */
  @Get()
  list(@CurrentUser() user: User, @Query() query: ListLessonsQueryDto) {
    return this.lessons.findInRange(user, query);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateLessonDto) {
    return this.lessons.create(user, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Body() dto: UpdateLessonStatusDto,
  ) {
    return this.lessons.updateStatus(user, id, dto);
  }
}
