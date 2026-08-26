import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { LessonStatus, UserRole } from '../../generated/prisma/enums';
import {
  summariseAttendance,
  summariseGrades,
  type AttendanceSummary,
  type GradeSummary,
} from '../gradebook/progress';
import { PrismaService } from '../prisma/prisma.service';
import type { ReportQueryDto } from './dto/report-query.dto';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

/**
 * The widest window one report may cover.
 *
 * The same bound the calendar uses, for the same reason: without it an ordinary
 * account can ask for the year 1970 to 2100 and make the database read every
 * lesson a school has ever taught. A little over a year, so that "this academic
 * year" fits.
 */
const MAX_WINDOW_DAYS = 400;

/** How many rows a single breakdown may name before the tail is dropped. */
const MAX_BREAKDOWN_ROWS = 20;

/** Work done, grouped by whatever it was grouped by. */
export type ReportBreakdown = {
  id: string | null;
  /** Null where the lesson recorded no subject — shown as such, not invented. */
  name: string | null;
  lessons: number;
  minutes: number;
};

export type Report = {
  from: string;
  to: string;
  /**
   * Whose work this counts: one tutor, or null for the whole school.
   *
   * One field rather than a tutor id beside a "school-wide" flag, because the
   * flag would be derivable from the id and two fields that can disagree
   * eventually do. The app has everything it needs to caption the screen — null
   * is the school, the caller's own id is "my lessons", anyone else's is theirs.
   */
  scope: { tutorId: string | null };
  lessons: {
    total: number;
    completed: number;
    cancelled: number;
    scheduled: number;
  };
  /**
   * Minutes actually taught — completed lessons only.
   *
   * Scheduled ones are a plan and cancelled ones did not happen, so counting
   * either would ruin the number for the thing it is for: how much work was
   * done, and what it was worth.
   */
  minutesTaught: number;
  /** Distinct students taught in the window, one-to-one and in groups. */
  studentsTaught: number;
  attendance: AttendanceSummary;
  grades: GradeSummary;
  bySubject: ReportBreakdown[];
  /** Per tutor, for a school-wide report. Null when somebody reads their own. */
  byTutor: ReportBreakdown[] | null;
};

/** The lesson columns a report needs, and no more. */
type ReportLesson = {
  status: LessonStatus;
  durationMinutes: number;
  subjectId: string | null;
  tutorId: string;
  studentId: string | null;
  groupId: string | null;
  subject: { name: string } | null;
};

@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(user: User, query: ReportQueryDto): Promise<Report> {
    const { from, to } = this.window(query);
    const tutorId = this.tutorScope(user, query);
    const byTutor = tutorId === null ? {} : { tutorId };

    const lessons: ReportLesson[] = await this.prisma.lesson.findMany({
      where: {
        schoolId: user.schoolId,
        ...byTutor,
        startsAt: { gte: from, lt: to },
      },
      select: {
        status: true,
        durationMinutes: true,
        subjectId: true,
        tutorId: true,
        studentId: true,
        groupId: true,
        subject: { select: { name: true } },
      },
    });

    const [attendances, grades, studentsTaught] = await Promise.all([
      this.prisma.lessonAttendance.findMany({
        where: {
          lesson: {
            schoolId: user.schoolId,
            ...byTutor,
            startsAt: { gte: from, lt: to },
          },
        },
        select: { status: true },
      }),
      this.prisma.grade.findMany({
        where: {
          // Grades carry no school of their own — the student is the owner, and
          // asking through them is the same rule the gradebook enforces.
          student: { schoolId: user.schoolId },
          ...(tutorId === null ? {} : { authorId: tutorId }),
          createdAt: { gte: from, lt: to },
        },
        select: { kind: true, value: true, weight: true },
      }),
      this.countStudentsTaught(lessons),
    ]);

    const completed = lessons.filter(
      (lesson) => lesson.status === LessonStatus.COMPLETED,
    );

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      scope: { tutorId },
      lessons: {
        total: lessons.length,
        completed: completed.length,
        cancelled: this.countWith(lessons, LessonStatus.CANCELLED),
        scheduled: this.countWith(lessons, LessonStatus.SCHEDULED),
      },
      minutesTaught: completed.reduce(
        (total, lesson) => total + lesson.durationMinutes,
        0,
      ),
      studentsTaught,
      attendance: summariseAttendance(attendances),
      grades: summariseGrades(grades),
      bySubject: this.breakdown(completed, (lesson) => ({
        id: lesson.subjectId,
        name: lesson.subject?.name ?? null,
      })),
      byTutor:
        tutorId === null ? await this.tutorBreakdown(user, completed) : null,
    };
  }

  private countWith(
    lessons: readonly ReportLesson[],
    status: LessonStatus,
  ): number {
    return lessons.filter((lesson) => lesson.status === status).length;
  }

  /**
   * The window, defaulted and bounded.
   *
   * Defaults backwards from `to` rather than forwards from `from`, because a
   * report is about work already done: "the last thirty days" is what somebody
   * means when they name neither end.
   */
  private window(query: ReportQueryDto): { from: Date; to: Date } {
    const to = query.to === undefined ? new Date() : new Date(query.to);
    const from =
      query.from === undefined
        ? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS)
        : new Date(query.from);

    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('The window has to start before it ends');
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A report can cover at most ${MAX_WINDOW_DAYS} days`,
      );
    }

    return { from, to };
  }

  /** Whose lessons this counts, and whether the caller may ask for them. */
  private tutorScope(user: User, query: ReportQueryDto): string | null {
    if (user.role === UserRole.ADMIN) {
      return query.tutorId ?? null;
    }
    if (query.tutorId !== undefined && query.tutorId !== user.id) {
      // Refused rather than quietly answered with their own numbers: a report
      // that answers a different question than the one asked is worse than an
      // error, because nothing about it looks wrong.
      throw new ForbiddenException('Only an admin can report on another tutor');
    }

    return user.id;
  }

  /**
   * Distinct students taught, counting the people in a group lesson rather than
   * the group.
   *
   * Uses current membership, which is the one inaccuracy here: somebody who left
   * a group last week is not counted for the lessons they sat in, and somebody
   * who joined yesterday is. Recording membership per lesson is the fix, and
   * that is a schema change rather than a query change.
   */
  private async countStudentsTaught(
    lessons: readonly { studentId: string | null; groupId: string | null }[],
  ): Promise<number> {
    const students = new Set<string>();
    const groups = new Set<string>();

    for (const lesson of lessons) {
      if (lesson.studentId !== null) students.add(lesson.studentId);
      if (lesson.groupId !== null) groups.add(lesson.groupId);
    }

    if (groups.size > 0) {
      const members = await this.prisma.groupMember.findMany({
        where: { groupId: { in: [...groups] } },
        select: { studentId: true },
      });
      for (const member of members) students.add(member.studentId);
    }

    return students.size;
  }

  /** Names for the per-tutor rows, fetched once rather than per row. */
  private async tutorBreakdown(
    user: User,
    lessons: readonly ReportLesson[],
  ): Promise<ReportBreakdown[]> {
    const names = new Map(
      (
        await this.prisma.user.findMany({
          where: { schoolId: user.schoolId },
          select: { id: true, name: true },
        })
      ).map((tutor) => [tutor.id, tutor.name]),
    );

    return this.breakdown(lessons, (lesson) => ({
      id: lesson.tutorId,
      name: names.get(lesson.tutorId) ?? null,
    }));
  }

  /**
   * Counts and minutes per key, busiest first.
   *
   * Capped, and the remainder is dropped rather than summed into an "other" row:
   * a school with sixty subjects wants the twenty it actually teaches, and a
   * bucket labelled "other" invites the reader to treat it as a subject.
   */
  private breakdown(
    lessons: readonly ReportLesson[],
    keyOf: (lesson: ReportLesson) => { id: string | null; name: string | null },
  ): ReportBreakdown[] {
    const rows = new Map<string, ReportBreakdown>();

    for (const lesson of lessons) {
      const { id, name } = keyOf(lesson);
      const key = id ?? '';
      const row = rows.get(key) ?? { id, name, lessons: 0, minutes: 0 };
      row.lessons += 1;
      row.minutes += lesson.durationMinutes;
      rows.set(key, row);
    }

    return [...rows.values()]
      .sort((a, b) => b.minutes - a.minutes || b.lessons - a.lessons)
      .slice(0, MAX_BREAKDOWN_ROWS);
  }
}
