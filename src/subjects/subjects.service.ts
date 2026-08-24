import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Subject, User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateSubjectDto, UpdateSubjectDto } from './dto/subject.dto';

/**
 * What still points at a subject, and therefore what has to be dealt with before
 * it can be taken off the list.
 *
 * Students and groups block, because they describe what somebody is studying
 * now. Upcoming lessons block for the same reason. Lessons already taught do
 * not, and that distinction is the point: a subject taught for three years has
 * hundreds of finished lessons behind it, and if those counted it could never be
 * retired at all.
 */
export type SubjectUsage = {
  subject: Subject;
  students: { id: string; name: string }[];
  groups: { id: string; name: string }[];
  upcomingLessons: number;
  /** Reported so the admin can see what hiding preserves rather than blocks. */
  pastLessons: number;
  canHide: boolean;
};

@Injectable()
export class SubjectsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * What the school teaches.
   *
   * Any member may read it: every booking form and every student form needs the
   * list to offer. Hidden subjects are left out unless asked for, which is the
   * management screen and nothing else.
   */
  list(user: User, includeHidden = false) {
    return this.prisma.subject.findMany({
      where: {
        schoolId: user.schoolId,
        ...(includeHidden ? {} : { hiddenAt: null }),
      },
      orderBy: { name: 'asc' },
    });
  }

  /** Scoped to the caller's school. Not-found for another school's row. */
  async findOne(user: User, id: string): Promise<Subject> {
    const subject = await this.prisma.subject.findUnique({ where: { id } });

    if (!subject || subject.schoolId !== user.schoolId) {
      throw new NotFoundException('Subject not found');
    }

    return subject;
  }

  /**
   * Looks a name up as a person would read it: trimmed, and without caring about
   * case.
   *
   * The unique index is case-sensitive, so it alone would happily accept
   * "algebra" beside "Algebra" — two subjects, one meaning, history split
   * between them. This is the check that stops it. Two admins typing the same
   * name at the same instant can still get past it, and the index catches that
   * one, which is the right division: the index guarantees, this explains.
   */
  private findByName(schoolId: string, name: string) {
    return this.prisma.subject.findFirst({
      where: { schoolId, name: { equals: name, mode: 'insensitive' } },
    });
  }

  async create(user: User, dto: CreateSubjectDto): Promise<Subject> {
    const name = dto.name.trim();
    const existing = await this.findByName(user.schoolId, name);

    if (existing) {
      // The hidden case is a separate code because it needs a different answer
      // in the app: "that name is taken" is useless when the row holding it is
      // one the admin cannot see. Offer to bring it back instead — which is also
      // what keeps the old lessons attached to it.
      throw new ConflictException({
        code: existing.hiddenAt ? 'SUBJECT_HIDDEN' : 'SUBJECT_EXISTS',
        message: existing.hiddenAt
          ? 'That subject exists but is hidden'
          : 'That subject already exists',
        subject: existing,
      });
    }

    return this.prisma.subject.create({
      data: { name, schoolId: user.schoolId },
    });
  }

  /**
   * Renames a subject, everywhere at once.
   *
   * Which is the reason this is a table: correcting a spelling used to mean
   * finding every student, group and lesson that had it typed in, and missing
   * one meant the school had two subjects again.
   */
  async rename(
    user: User,
    id: string,
    dto: UpdateSubjectDto,
  ): Promise<Subject> {
    const subject = await this.findOne(user, id);
    const name = dto.name.trim();

    const clash = await this.findByName(user.schoolId, name);
    if (clash && clash.id !== subject.id) {
      throw new ConflictException({
        code: clash.hiddenAt ? 'SUBJECT_HIDDEN' : 'SUBJECT_EXISTS',
        message: clash.hiddenAt
          ? 'That subject exists but is hidden'
          : 'That subject already exists',
        subject: clash,
      });
    }

    return this.prisma.subject.update({
      where: { id: subject.id },
      data: { name },
    });
  }

  /**
   * What still points at this subject.
   *
   * Read before hiding, and also on its own: the app shows this list so the
   * admin can see who has to be moved before the subject can come off, rather
   * than being refused with a number and left to find them.
   */
  async usage(user: User, id: string): Promise<SubjectUsage> {
    const subject = await this.findOne(user, id);
    const now = new Date();

    // One transaction so the counts and the lists describe the same moment. Four
    // separate reads could report a student who has just been reassigned and an
    // upcoming lesson that reassignment removed.
    const [students, groups, upcomingLessons, pastLessons] =
      await this.prisma.$transaction([
        this.prisma.student.findMany({
          where: { subjectId: subject.id },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.group.findMany({
          where: { subjectId: subject.id },
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        this.prisma.lesson.count({
          where: {
            subjectId: subject.id,
            startsAt: { gte: now },
            status: { not: 'CANCELLED' },
          },
        }),
        // A cancelled lesson in the future counts as past: nobody is going to
        // teach it, so it is history, and it must not block anything.
        this.prisma.lesson.count({
          where: {
            subjectId: subject.id,
            OR: [{ startsAt: { lt: now } }, { status: 'CANCELLED' }],
          },
        }),
      ]);

    return {
      subject,
      students,
      groups,
      upcomingLessons,
      pastLessons,
      canHide:
        students.length === 0 && groups.length === 0 && upcomingLessons === 0,
    };
  }

  /**
   * Takes a subject off the list without deleting it.
   *
   * Refused while anything current still points at it, and the refusal carries
   * the whole usage report: the app needs to say *which* students and groups to
   * move, and a bare 409 would send the admin looking for them by hand.
   *
   * Everything already taught stays attached and keeps reading normally. That is
   * the entire reason this is a flag and not a `DELETE`.
   */
  async hide(user: User, id: string): Promise<Subject> {
    const usage = await this.usage(user, id);

    if (!usage.canHide) {
      throw new ConflictException({
        code: 'SUBJECT_IN_USE',
        message: 'Reassign what still studies this subject first',
        usage,
      });
    }

    // Already hidden is not an error: the second admin to press it wanted the
    // same outcome, and it is the one they already have.
    if (usage.subject.hiddenAt) return usage.subject;

    return this.prisma.subject.update({
      where: { id: usage.subject.id },
      data: { hiddenAt: new Date() },
    });
  }

  /** Puts it back on the list, with everything that still names it intact. */
  async restore(user: User, id: string): Promise<Subject> {
    const subject = await this.findOne(user, id);

    return this.prisma.subject.update({
      where: { id: subject.id },
      data: { hiddenAt: null },
    });
  }

  /**
   * Turns a subject id from a client into one that is safe to store.
   *
   * Two things are checked and both matter. That the subject belongs to the
   * caller's school — without which a school could attach its records to a
   * neighbour's subject and rename it out from under them. And that it is still
   * offered, so a hidden subject cannot quietly come back through a booking
   * form.
   *
   * `current` is what the record already points at, and it is exempt from the
   * hidden check. Without it, editing a student who studies a subject the school
   * has since retired would be refused for a field the editor never touched —
   * they would have to reassign the student in order to correct their name.
   */
  async resolve(
    user: User,
    subjectId: string | null,
    current: string | null = null,
  ): Promise<string | null> {
    if (subjectId === null) return null;

    const subject = await this.findOne(user, subjectId);

    if (subject.hiddenAt && subject.id !== current) {
      throw new BadRequestException('That subject is no longer offered');
    }

    return subject.id;
  }
}
