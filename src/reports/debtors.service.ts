import { ForbiddenException, Injectable } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { LessonStatus, UserRole } from '../../generated/prisma/enums';
import { PrismaService } from '../prisma/prisma.service';
import type { DebtorQueryDto } from './dto/report-query.dto';

/**
 * Who has run out of paid lessons.
 *
 * Built on the balance that already exists rather than on a payments system:
 * `Student.paidLessonsLeft` is spent by the register — an attended or missed
 * lesson takes one, a lesson cancelled in time gives it back — so the arithmetic
 * of who owes what is already being done every time somebody writes a lesson up.
 * What was missing was the question "who?", which is this.
 *
 * That also sets the honest limit of the feature: this counts **lessons**, not
 * money. It does not know what a lesson costs, so it cannot say what anybody
 * owes in currency, and it says so rather than inventing a figure.
 */

/** How far a balance may fall before the list stays quiet. */
const DEFAULT_AT_OR_BELOW = 0;

export type Debtor = {
  studentId: string;
  name: string;
  tutorId: string;
  /** Null for a tutor who has left the school. */
  tutorName: string | null;
  /** What is left on the package. Zero or negative, by definition of this list. */
  paidLessonsLeft: number;
  /**
   * Lessons already taught beyond the package — the number to be paid for.
   *
   * Zero for somebody sitting exactly at the end of their package: they owe
   * nothing yet, and are here because another lesson is booked.
   */
  lessonsOwed: number;
  /** Still on the schedule, and so about to be owed too. */
  lessonsBooked: number;
  /** When they were last taught, so a stale entry is recognisable as one. */
  lastTaughtAt: string | null;
};

@Injectable()
export class DebtorsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: User, query: DebtorQueryDto): Promise<Debtor[]> {
    const tutorId = this.tutorScope(user, query);
    const atOrBelow = query.atOrBelow ?? DEFAULT_AT_OR_BELOW;

    const students = await this.prisma.student.findMany({
      where: {
        schoolId: user.schoolId,
        ...(tutorId === null ? {} : { tutorId }),
        paidLessonsLeft: { lte: atOrBelow },
      },
      select: {
        id: true,
        name: true,
        tutorId: true,
        paidLessonsLeft: true,
        tutor: { select: { name: true } },
      },
    });

    if (students.length === 0) return [];

    const ids = students.map((student) => student.id);
    const [booked, lastTaught] = await Promise.all([
      this.bookedPerStudent(ids),
      this.lastTaughtPerStudent(ids),
    ]);

    return (
      students
        .map((student) => ({
          studentId: student.id,
          name: student.name,
          tutorId: student.tutorId,
          tutorName: student.tutor?.name ?? null,
          paidLessonsLeft: student.paidLessonsLeft,
          // A balance of -3 means three lessons have been taught unpaid for.
          lessonsOwed: Math.max(0, -student.paidLessonsLeft),
          lessonsBooked: booked.get(student.id) ?? 0,
          lastTaughtAt: lastTaught.get(student.id)?.toISOString() ?? null,
        }))
        // A student who has never been charged and has nothing booked sits at zero
        // because nobody has ever bought them a package — a free trial, somebody
        // just added, a name on the books. Listing them as out of lessons would
        // make this screen mostly noise, and noise is what stops it being read.
        .filter((row) => row.lessonsOwed > 0 || row.lessonsBooked > 0)
        .sort(byUrgency)
    );
  }

  /**
   * Who this list covers.
   *
   * A tutor sees their own students, which is the same rule the roster uses; an
   * admin sees the school. Asking about a colleague is refused rather than
   * quietly answered with your own students — a list that answers a different
   * question than the one asked is worse than an error, because nothing about it
   * looks wrong.
   */
  private tutorScope(user: User, query: DebtorQueryDto): string | null {
    if (user.role === UserRole.ADMIN) {
      return query.tutorId ?? null;
    }
    if (query.tutorId !== undefined && query.tutorId !== user.id) {
      throw new ForbiddenException('Only an admin can ask about another tutor');
    }

    return user.id;
  }

  /**
   * Lessons still to come, per student, counting group lessons for everybody in
   * the room.
   *
   * Two queries rather than one, because a lesson reaches a student either
   * directly or through a group and Prisma cannot group by "the students this
   * row concerns". Counted here instead of in the loop so the cost does not grow
   * with the length of the list.
   */
  private async bookedPerStudent(
    ids: readonly string[],
  ): Promise<Map<string, number>> {
    const upcoming = { gte: new Date() };
    const counts = new Map<string, number>();
    const add = (studentId: string) =>
      counts.set(studentId, (counts.get(studentId) ?? 0) + 1);

    const own = await this.prisma.lesson.groupBy({
      by: ['studentId'],
      where: {
        studentId: { in: [...ids] },
        status: LessonStatus.SCHEDULED,
        startsAt: upcoming,
      },
      _count: { _all: true },
    });
    for (const row of own) {
      if (row.studentId !== null) {
        counts.set(row.studentId, row._count._all);
      }
    }

    const inGroups = await this.prisma.lesson.findMany({
      where: {
        status: LessonStatus.SCHEDULED,
        startsAt: upcoming,
        group: { members: { some: { studentId: { in: [...ids] } } } },
      },
      select: {
        group: { select: { members: { select: { studentId: true } } } },
      },
    });
    const wanted = new Set(ids);
    for (const lesson of inGroups) {
      for (const member of lesson.group?.members ?? []) {
        if (wanted.has(member.studentId)) add(member.studentId);
      }
    }

    return counts;
  }

  /** When each student was last actually taught. */
  private async lastTaughtPerStudent(
    ids: readonly string[],
  ): Promise<Map<string, Date>> {
    // From the register rather than from the schedule: a lesson somebody was
    // marked present at is one that happened, while a lesson with a date in the
    // past may simply never have been written up.
    const rows = await this.prisma.lessonAttendance.findMany({
      where: { studentId: { in: [...ids] } },
      select: { studentId: true, lesson: { select: { startsAt: true } } },
      orderBy: { lesson: { startsAt: 'desc' } },
    });

    const last = new Map<string, Date>();
    for (const row of rows) {
      if (!last.has(row.studentId))
        last.set(row.studentId, row.lesson.startsAt);
    }

    return last;
  }
}

/**
 * Deepest in debt first, then whoever has most booked, then by name.
 *
 * The order is the point of the screen: it answers "who do I speak to first".
 * Somebody three lessons down with two more booked is a conversation today;
 * somebody at exactly zero with nothing booked can wait.
 */
function byUrgency(left: Debtor, right: Debtor): number {
  return (
    right.lessonsOwed - left.lessonsOwed ||
    right.lessonsBooked - left.lessonsBooked ||
    left.name.localeCompare(right.name)
  );
}
