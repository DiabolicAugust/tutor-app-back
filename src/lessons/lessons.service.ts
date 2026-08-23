import { Injectable, NotFoundException } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { LessonStatus } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import type {
  CreateLessonDto,
  ListLessonsQueryDto,
} from './dto/create-lesson.dto';
import type { UpdateLessonStatusDto } from './dto/update-lesson-status.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

@Injectable()
export class LessonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  /**
   * The lessons visible in a date window.
   *
   * A window is required rather than optional: the calendar only ever renders a
   * day, three days or a month, and an unbounded list would grow without limit
   * for a school that has been running a year.
   */
  findInRange(user: User, query: ListLessonsQueryDto) {
    const from = query.from ? new Date(query.from) : startOfToday();
    const to = query.to
      ? new Date(query.to)
      : new Date(from.getTime() + DEFAULT_WINDOW_DAYS * DAY_MS);

    const requestedTutors = query.tutorIds
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    return this.prisma.lesson.findMany({
      where: {
        // Tenant isolation first: every other condition narrows within it.
        schoolId: user.schoolId,
        startsAt: { gte: from, lt: to },
        ...(requestedTutors?.length
          ? { tutorId: { in: requestedTutors } }
          : user.role === 'ADMIN'
            ? {}
            : { tutorId: user.id }),
      },
      orderBy: { startsAt: 'asc' },
      include: { student: { select: { id: true, name: true } } },
    });
  }

  /**
   * Books a lesson.
   *
   * Always onto the caller's own calendar — booking into a colleague's time is a
   * different feature with different rules, and the app deliberately offers no
   * such option. `findOne` also proves the student is theirs.
   */
  async create(user: User, dto: CreateLessonDto) {
    const student = await this.students.findOne(user, dto.studentId);

    return this.prisma.lesson.create({
      data: {
        subject: dto.subject.trim(),
        startsAt: new Date(dto.startsAt),
        durationMinutes: dto.durationMinutes,
        schoolId: user.schoolId,
        tutorId: user.id,
        studentId: student.id,
      },
    });
  }

  /**
   * Confirms or cancels a lesson.
   *
   * Marking one completed spends a lesson from the student's package, in the
   * same transaction — a balance that drifts from the schedule is worse than no
   * balance at all.
   */
  async updateStatus(user: User, id: string, dto: UpdateLessonStatusDto) {
    const lesson = await this.prisma.lesson.findUnique({ where: { id } });
    if (!lesson || lesson.schoolId !== user.schoolId) {
      throw new NotFoundException('Lesson not found');
    }
    if (lesson.tutorId !== user.id && user.role !== 'ADMIN') {
      throw new NotFoundException('Lesson not found');
    }

    const spendsLesson =
      dto.status === LessonStatus.COMPLETED &&
      lesson.status !== LessonStatus.COMPLETED;

    return this.prisma.$transaction(async (tx) => {
      if (spendsLesson) {
        await tx.student.update({
          where: { id: lesson.studentId },
          data: { paidLessonsLeft: { decrement: 1 } },
        });
      }

      return tx.lesson.update({
        where: { id: lesson.id },
        data: { status: dto.status },
      });
    });
  }
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}
