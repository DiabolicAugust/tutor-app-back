import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import type {
  CreateLessonDto,
  ListLessonsQueryDto,
} from './dto/create-lesson.dto';
import type { UpdateLessonStatusDto } from './dto/update-lesson-status.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;
/** Enough history to be useful, bounded so a long-standing student stays fast. */
const HISTORY_LIMIT = 100;

/**
 * What every lesson read carries with it.
 *
 * The group's members come along rather than being fetched on demand, because
 * the calendar renders a group lesson by its name and expands it to the people
 * in it — and a request per block would make expanding feel like loading.
 */
const WITH_SUBJECT = {
  student: { select: { id: true, name: true } },
  group: {
    select: {
      id: true,
      name: true,
      subject: true,
      level: true,
      members: {
        orderBy: { student: { name: 'asc' } },
        select: { student: { select: { id: true, name: true } } },
      },
    },
  },
} as const;

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
      include: WITH_SUBJECT,
    });
  }

  /**
   * One student's lessons, newest first.
   *
   * Includes the lessons of every group they are in, which is the only reading
   * that matches what a student experiences: from their side there is no
   * difference between being taught alone and being taught with four others.
   *
   * A separate query from the calendar's rather than another filter on it: the
   * calendar always asks "what is in this window", while a student's page asks
   * "what has happened", and the two want opposite orderings and opposite
   * defaults. `findOne` proves the caller may see the student, which is also what
   * decides whether they may see these lessons.
   */
  async findForStudent(user: User, studentId: string, limit = HISTORY_LIMIT) {
    const student = await this.students.findOne(user, studentId);

    return this.prisma.lesson.findMany({
      where: {
        OR: [
          { studentId: student.id },
          { group: { members: { some: { studentId: student.id } } } },
        ],
      },
      orderBy: { startsAt: 'desc' },
      take: limit,
      include: {
        ...WITH_SUBJECT,
        // The count is what the app shows without opening a lesson: whether
        // anybody wrote anything down.
        _count: { select: { notes: true } },
        // Only this student's row, so a group lesson still renders one
        // attendance state on their own history rather than the whole room's.
        attendances: { where: { studentId: student.id } },
      },
    });
  }

  /**
   * Books a lesson, for one student or for a group.
   *
   * Always onto the caller's own calendar — booking into a colleague's time is a
   * different feature with different rules, and the app deliberately offers no
   * such option. The ownership check on whichever subject was named also proves
   * the caller may book for it.
   */
  async create(user: User, dto: CreateLessonDto) {
    // Exactly one, checked here because the database cannot express it and
    // because "neither" and "both" are both callers getting it wrong.
    if ((dto.studentId === undefined) === (dto.groupId === undefined)) {
      throw new BadRequestException(
        'A lesson is for exactly one student or one group',
      );
    }

    const common = {
      subject: dto.subject.trim(),
      startsAt: new Date(dto.startsAt),
      durationMinutes: dto.durationMinutes,
      schoolId: user.schoolId,
      tutorId: user.id,
    };

    if (dto.groupId !== undefined) {
      const group = await this.findReachableGroup(user, dto.groupId);
      return this.prisma.lesson.create({
        data: { ...common, groupId: group.id },
        include: WITH_SUBJECT,
      });
    }

    const student = await this.students.findOne(user, dto.studentId!);
    return this.prisma.lesson.create({
      data: { ...common, studentId: student.id },
      include: WITH_SUBJECT,
    });
  }

  /**
   * The lesson, if this caller may touch it at all.
   *
   * The single place that answers that question: a tutor reaches their own
   * lessons, an admin the school's. Public because notes and the gradebook hang
   * off a lesson and must apply exactly this rule — three copies of an
   * authorization check is three chances for one of them to drift.
   *
   * Not-found rather than forbidden for another school's row, and for a
   * colleague's lesson too: a 403 would confirm the id exists.
   */
  async findReachable(user: User, id: string) {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id },
      include: WITH_SUBJECT,
    });

    if (!lesson || lesson.schoolId !== user.schoolId) {
      throw new NotFoundException('Lesson not found');
    }
    if (lesson.tutorId !== user.id && user.role !== 'ADMIN') {
      throw new NotFoundException('Lesson not found');
    }

    return lesson;
  }

  /**
   * Moves a lesson in the schedule: confirmed, cancelled, back to scheduled.
   *
   * Deliberately does **not** touch anybody's balance. Charging follows
   * *attendance*, which is per-student — see `GradebookService.writeJournal` —
   * and it has to, because a group lesson charges the people who came and not
   * the one who cancelled in time. Two places that both spend a lesson would
   * eventually spend it twice.
   */
  async updateStatus(user: User, id: string, dto: UpdateLessonStatusDto) {
    const lesson = await this.findReachable(user, id);

    return this.prisma.lesson.update({
      where: { id: lesson.id },
      data: { status: dto.status },
      include: WITH_SUBJECT,
    });
  }

  /**
   * The students a lesson is for: the one it names, or everyone in its group.
   *
   * The single answer to that question, so the gradebook does not have to
   * re-derive it — and so a group lesson automatically covers whoever is in the
   * group *now* rather than whoever was in it when the lesson was booked.
   */
  async studentIdsFor(lessonId: string): Promise<string[]> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        studentId: true,
        group: { select: { members: { select: { studentId: true } } } },
      },
    });

    if (!lesson) return [];
    if (lesson.studentId) return [lesson.studentId];
    return lesson.group?.members.map((member) => member.studentId) ?? [];
  }

  /** A group the caller may book for. Same rule as a student. */
  private async findReachableGroup(user: User, id: string) {
    const group = await this.prisma.group.findUnique({ where: { id } });

    if (!group || group.schoolId !== user.schoolId) {
      throw new NotFoundException('Group not found');
    }
    if (user.role !== 'ADMIN' && group.tutorId !== user.id) {
      throw new NotFoundException('Group not found');
    }

    return group;
  }
}

function startOfToday(): Date {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}
