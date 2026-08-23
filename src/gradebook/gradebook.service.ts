import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Grade, User } from '../../generated/prisma/client';
import {
  AttendanceStatus,
  GradeKind,
  LessonStatus,
} from '../../generated/prisma/enums';
import { LessonsService } from '../lessons/lessons.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import type { WriteGradeDto } from './dto/write-grade.dto';
import type { WriteJournalDto } from './dto/write-journal.dto';
import { summariseProgress, type ProgressSummary } from './progress';

/** What the app renders: the mark, plus who gave it. */
export type GradeWithAuthor = Grade & { author: { id: string; name: string } };

const AUTHOR = { select: { id: true, name: true } } as const;

/** Percentages are a fixed scale, unlike a school's classic one. */
const MAX_PERCENTAGE = 100;

/**
 * Whether a student is charged for a lesson they were marked at.
 *
 * A no-show is charged, and that is the point of the excused/unexcused split:
 * the hour was held and the tutor was there, so the lesson is spent. An excused
 * absence — cancelled in time, or a reason the school accepts — gives the slot
 * back and costs nothing.
 *
 * This set is the whole cancellation policy, in one place, changeable without
 * touching a query. Per *student*, because in a group the person who cancelled
 * in time must not be charged for the lesson the others attended.
 */
const CHARGED: ReadonlySet<AttendanceStatus> = new Set([
  AttendanceStatus.PRESENT,
  AttendanceStatus.LATE,
  AttendanceStatus.ABSENT_UNEXCUSED,
]);

/**
 * The gradebook: what happened in a lesson, and how the student is doing.
 *
 * Owns no authorization rule of its own. A lesson's journal is writable exactly
 * when the lesson is reachable, and a grade exactly when its student is — both
 * questions are already answered by the service that owns the parent row, and
 * asking them again here would be a second rule to keep in step with the first.
 */
@Injectable()
export class GradebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly lessons: LessonsService,
  ) {}

  /**
   * Writes up a lesson: topic, homework, the register — in one call.
   *
   * Only the fields present in the payload are written, so this serves both the
   * full write-up and a single tap on "was here". One transaction, because the
   * register and the balances it moves must not be able to disagree.
   *
   * Marking a student charges them a lesson, or gives one back if the mark is
   * corrected the other way — see `CHARGED`. The symmetry matters: changing
   * "no-show" to "excused" has to refund, or a correction leaves the student
   * paying for the tutor's typo.
   *
   * The lesson's own status is derived from the register unless the caller states
   * one: anybody charged means it happened, everybody excused means it did not.
   */
  async writeJournal(user: User, lessonId: string, dto: WriteJournalDto) {
    const lesson = await this.lessons.findReachable(user, lessonId);
    const marks = dto.attendance ?? [];

    if (marks.length > 0) {
      // Whoever the lesson is actually for — the one student it names, or the
      // group's members as they stand now.
      const eligible = new Set(await this.lessons.studentIdsFor(lesson.id));
      const stranger = marks.find((mark) => !eligible.has(mark.studentId));
      if (stranger) {
        throw new BadRequestException('That student is not in this lesson');
      }

      const duplicated =
        new Set(marks.map((mark) => mark.studentId)).size !== marks.length;
      if (duplicated) {
        throw new BadRequestException('One entry per student');
      }
    }

    const status = dto.status ?? statusFromRegister(marks);

    return this.prisma.$transaction(async (tx) => {
      for (const mark of marks) {
        const existing = await tx.lessonAttendance.findUnique({
          where: {
            lessonId_studentId: {
              lessonId: lesson.id,
              studentId: mark.studentId,
            },
          },
        });

        const wasCharged = existing ? CHARGED.has(existing.status) : false;
        const isCharged = CHARGED.has(mark.status);

        if (wasCharged !== isCharged) {
          await tx.student.update({
            where: { id: mark.studentId },
            data: {
              paidLessonsLeft: isCharged ? { decrement: 1 } : { increment: 1 },
            },
          });
        }

        await tx.lessonAttendance.upsert({
          where: {
            lessonId_studentId: {
              lessonId: lesson.id,
              studentId: mark.studentId,
            },
          },
          create: {
            lessonId: lesson.id,
            studentId: mark.studentId,
            status: mark.status,
            homeworkDone: mark.homeworkDone ?? null,
          },
          update: {
            status: mark.status,
            // Omitted leaves it alone, so marking the register does not wipe a
            // homework check made a week later.
            ...(mark.homeworkDone === undefined
              ? {}
              : { homeworkDone: mark.homeworkDone }),
          },
        });
      }

      return tx.lesson.update({
        where: { id: lesson.id },
        data: {
          // Trimmed to null rather than stored empty, so "cleared" and "never
          // written" are the same state instead of two that render differently.
          ...(dto.topic !== undefined ? { topic: blankToNull(dto.topic) } : {}),
          ...(dto.homework !== undefined
            ? { homework: blankToNull(dto.homework) }
            : {}),
          ...(status !== undefined ? { status } : {}),
        },
        include: {
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
          attendances: true,
        },
      });
    });
  }

  /** The register for one lesson — every student marked, in name order. */
  async registerFor(user: User, lessonId: string) {
    const lesson = await this.lessons.findReachable(user, lessonId);

    return this.prisma.lessonAttendance.findMany({
      where: { lessonId: lesson.id },
      include: { student: { select: { id: true, name: true } } },
      orderBy: { student: { name: 'asc' } },
    });
  }

  /** A student's marks, newest first. */
  async listForStudent(
    user: User,
    studentId: string,
  ): Promise<GradeWithAuthor[]> {
    const student = await this.students.findOne(user, studentId);

    return this.prisma.grade.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      include: { author: AUTHOR },
    });
  }

  /** The marks given in one lesson. */
  async listForLesson(
    user: User,
    lessonId: string,
  ): Promise<GradeWithAuthor[]> {
    const lesson = await this.lessons.findReachable(user, lessonId);

    return this.prisma.grade.findMany({
      where: { lessonId: lesson.id },
      orderBy: { createdAt: 'desc' },
      include: { author: AUTHOR },
    });
  }

  async addForStudent(
    user: User,
    studentId: string,
    dto: WriteGradeDto,
  ): Promise<GradeWithAuthor> {
    const student = await this.students.findOne(user, studentId);
    await this.assertValueInScale(user, dto);

    return this.prisma.grade.create({
      data: { ...this.dataFrom(dto), studentId: student.id, authorId: user.id },
      include: { author: AUTHOR },
    });
  }

  /**
   * Adds a mark from inside a lesson.
   *
   * For a one-to-one lesson the student comes from the lesson, because the lesson
   * already knows whose it is and a second answer could disagree with the first.
   * For a group lesson it cannot know, so the caller names one — and it has to be
   * somebody actually in the group, or a tutor could file a mark against a
   * student they never taught.
   */
  async addForLesson(
    user: User,
    lessonId: string,
    dto: WriteGradeDto,
  ): Promise<GradeWithAuthor> {
    const lesson = await this.lessons.findReachable(user, lessonId);
    const studentId = await this.resolveMarked(lesson, dto.studentId);
    await this.assertValueInScale(user, dto);

    return this.prisma.grade.create({
      data: {
        ...this.dataFrom(dto),
        studentId,
        lessonId: lesson.id,
        authorId: user.id,
      },
      include: { author: AUTHOR },
    });
  }

  /**
   * Which student a mark filed against a lesson belongs to.
   *
   * Rejects a named student on a one-to-one lesson rather than ignoring it: a
   * caller that sent the wrong id should hear about it, not have it silently
   * overwritten with the right one.
   */
  private async resolveMarked(
    lesson: { id: string; studentId: string | null },
    named: string | undefined,
  ): Promise<string> {
    if (lesson.studentId) {
      if (named !== undefined && named !== lesson.studentId) {
        throw new BadRequestException('That student is not in this lesson');
      }
      return lesson.studentId;
    }

    if (named === undefined) {
      throw new BadRequestException(
        'A mark on a group lesson must name the student',
      );
    }

    const members = await this.lessons.studentIdsFor(lesson.id);
    if (!members.includes(named)) {
      throw new BadRequestException('That student is not in this lesson');
    }

    return named;
  }

  /**
   * Corrects a mark.
   *
   * A full replacement rather than a patch: changing the kind changes which
   * fields are meaningful, and merging half a new kind onto half an old one
   * produces rows like a descriptive grade that still carries a number.
   */
  async update(
    user: User,
    id: string,
    dto: WriteGradeDto,
  ): Promise<GradeWithAuthor> {
    const grade = await this.findWritable(user, id);
    await this.assertValueInScale(user, dto);

    return this.prisma.grade.update({
      where: { id: grade.id },
      data: this.dataFrom(dto),
      include: { author: AUTHOR },
    });
  }

  async remove(user: User, id: string): Promise<void> {
    const grade = await this.findWritable(user, id);
    await this.prisma.grade.delete({ where: { id: grade.id } });
  }

  /**
   * How the student is doing: lessons, attendance, averages.
   *
   * Computed on read rather than kept on the student. A stored average is a
   * cache, and this one would have to be invalidated by every grade written,
   * corrected, deleted and every lesson marked — for a number derived from at
   * most a few hundred rows the school already owns.
   */
  async progressForStudent(
    user: User,
    studentId: string,
  ): Promise<ProgressSummary> {
    const student = await this.students.findOne(user, studentId);

    const [lessons, grades, attendances] = await Promise.all([
      this.prisma.lesson.findMany({
        // Group lessons count as this student's lessons, because from their side
        // there is no difference between being taught alone and being taught
        // with four others.
        where: {
          OR: [
            { studentId: student.id },
            { group: { members: { some: { studentId: student.id } } } },
          ],
        },
        select: { status: true },
      }),
      this.prisma.grade.findMany({
        where: { studentId: student.id },
        select: { kind: true, value: true, weight: true },
      }),
      // Their own rows only: a group lesson holds the whole room's register, and
      // this student's rate is about them.
      this.prisma.lessonAttendance.findMany({
        where: { studentId: student.id },
        select: { status: true },
      }),
    ]);

    return summariseProgress(lessons, grades, attendances);
  }

  /**
   * The mark, if this caller may change it.
   *
   * Reachability first — through the student, which is the owner every grade has
   * — and then authorship. Only the author or an admin, the same rule notes use:
   * a colleague silently rewriting a mark somebody else gave is not a feature
   * anybody asked for, and it is the kind of edit that gets noticed late.
   */
  private async findWritable(user: User, id: string) {
    const grade = await this.prisma.grade.findUnique({ where: { id } });
    if (!grade) throw new NotFoundException('Grade not found');

    await this.students.findOne(user, grade.studentId);

    if (grade.authorId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the author can change this grade');
    }

    return grade;
  }

  /**
   * Checks the number against the scale it is on.
   *
   * Not expressible in the DTO: a classic mark's ceiling is the school's
   * `gradeScaleMax`, and validation runs before anything has queried a school.
   * Without this, a 12 typed into a school that grades out of 6 becomes an
   * average nobody can explain.
   */
  private async assertValueInScale(user: User, dto: WriteGradeDto) {
    if (dto.kind === GradeKind.DESCRIPTIVE || dto.value === undefined) return;

    if (dto.kind === GradeKind.PERCENTAGE) {
      if (dto.value > MAX_PERCENTAGE) {
        throw new BadRequestException('A percentage cannot exceed 100');
      }
      return;
    }

    const school = await this.prisma.school.findUniqueOrThrow({
      where: { id: user.schoolId },
      select: { gradeScaleMax: true },
    });

    if (dto.value > school.gradeScaleMax) {
      throw new BadRequestException(
        `This school grades out of ${school.gradeScaleMax}`,
      );
    }
  }

  /**
   * The columns a payload becomes.
   *
   * A descriptive mark's `value` and a numeric mark's absent fields are written
   * as null rather than left alone, because this shape is also used for a
   * correction — and a row that keeps the old kind's leftovers is a row whose
   * kind and contents disagree.
   */
  private dataFrom(dto: WriteGradeDto) {
    const descriptive = dto.kind === GradeKind.DESCRIPTIVE;

    return {
      kind: dto.kind,
      value: descriptive ? null : (dto.value ?? null),
      category: blankToNull(dto.category),
      comment: blankToNull(dto.comment),
      weight: dto.weight ?? 1,
    };
  }
}

/**
 * What a register says about the lesson it belongs to.
 *
 * Anybody charged means the lesson happened — one student turning up is enough,
 * and a no-show is charged because the hour was held. Everybody excused means it
 * did not happen at all, which is the one case the slot is genuinely given back.
 *
 * `undefined` when nothing was marked, so an empty register leaves the schedule
 * alone rather than quietly cancelling a lesson.
 */
function statusFromRegister(
  marks: readonly { status: AttendanceStatus }[],
): LessonStatus | undefined {
  if (marks.length === 0) return undefined;

  return marks.some((mark) => CHARGED.has(mark.status))
    ? LessonStatus.COMPLETED
    : LessonStatus.CANCELLED;
}

/** Empty and whitespace-only both mean "not written". */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}
