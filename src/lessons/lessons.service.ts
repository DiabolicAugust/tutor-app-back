import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import type { MeetingProvider } from '../../generated/prisma/enums';
import { MeetingAccountsService } from '../meetings/meeting-accounts.service';
import { meetingLinkFor } from '../meetings/meeting-providers';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import { SubjectsService } from '../subjects/subjects.service';
import { parseUserConfig } from '../users/user-config';
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
 * The widest window a single calendar request may ask for.
 *
 * The window was already required, and that alone was not a limit: nothing
 * stopped a client asking for the year 1970 to 2100, which returns every lesson
 * a school has ever had, each with its group's full membership attached. One
 * such request is slow; a few in parallel are a way to keep the database busy
 * with no credentials beyond an ordinary account.
 *
 * A year and a bit — comfortably more than the app asks for, since the widest
 * view it renders is a month, and enough that a future "this academic year"
 * screen needs no change here.
 */
const MAX_WINDOW_DAYS = 400;

/**
 * How many calendars one request may overlay.
 *
 * The app's filter is a list of colleagues, and a school has tens of them, not
 * thousands. Without a cap the `IN` list is whatever a client chooses to send.
 */
const MAX_TUTOR_FILTERS = 50;

/**
 * What every lesson read carries with it.
 *
 * The group's members come along rather than being fetched on demand, because
 * the calendar renders a group lesson by its name and expands it to the people
 * in it — and a request per block would make expanding feel like loading.
 */
/**
 * The lesson shape every endpoint returns: who it is for, and what it teaches.
 *
 * Exported because the gradebook returns lessons too, and it returned them with
 * an include of its own that had drifted a field behind this one. One app type
 * describes both, so one constant has to build both.
 */
export const WITH_ATTENDEES = {
  subject: { select: { id: true, name: true, hiddenAt: true } },
  student: { select: { id: true, name: true } },
  group: {
    select: {
      id: true,
      name: true,
      subject: { select: { id: true, name: true, hiddenAt: true } },
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
    private readonly subjects: SubjectsService,
    private readonly meetings: MeetingAccountsService,
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

    if (to <= from) {
      throw new BadRequestException('The window must end after it starts');
    }
    if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
      throw new BadRequestException(
        `A calendar window cannot be longer than ${MAX_WINDOW_DAYS} days`,
      );
    }

    const requestedTutors = query.tutorIds
      ?.split(',')
      .map((id) => id.trim())
      .filter(Boolean);

    if (requestedTutors && requestedTutors.length > MAX_TUTOR_FILTERS) {
      throw new BadRequestException(
        `A request cannot ask for more than ${MAX_TUTOR_FILTERS} calendars`,
      );
    }

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
      include: WITH_ATTENDEES,
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
        ...WITH_ATTENDEES,
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

    const subjectId = await this.subjects.resolve(user, dto.subjectId ?? null);
    const startsAt = new Date(dto.startsAt);

    // Read from the tutor's settings at booking time and then stored, which is
    // what makes the link stable: see the note on `Lesson.meetingUrl`.
    const meeting = await this.meetingFor(user, {
      subjectId,
      startsAt,
      durationMinutes: dto.durationMinutes,
    });

    const common = {
      subjectId,
      startsAt,
      durationMinutes: dto.durationMinutes,
      schoolId: user.schoolId,
      tutorId: user.id,
      meetingUrl: meeting?.url ?? null,
      meetingProvider: meeting?.provider ?? null,
    };

    if (dto.groupId !== undefined) {
      const group = await this.findReachableGroup(user, dto.groupId);
      return this.prisma.lesson.create({
        data: { ...common, groupId: group.id },
        include: WITH_ATTENDEES,
      });
    }

    const student = await this.students.findOne(user, dto.studentId!);
    return this.prisma.lesson.create({
      data: { ...common, studentId: student.id },
      include: WITH_ATTENDEES,
    });
  }

  /**
   * The room a lesson being booked gets, if any.
   *
   * Two ways to arrive at one, tried in this order:
   *
   * 1. **A connected account.** Zoom and Google will create a room per lesson
   *    once the tutor has authorised it, which is the version of this feature
   *    people actually want: a separate room per hour, with its own link.
   * 2. **The room they already own**, from their settings. What Zoom and Google
   *    can offer before they have connected anything, and all Jitsi ever needs.
   *
   * A failure at step 1 falls through to step 2 rather than failing the booking.
   * That is deliberate: a lesson is a commitment between two people and must not
   * fail to exist because a third party had a bad minute. The failure is logged,
   * and a revoked connection is dropped so the settings screen stops claiming
   * otherwise.
   */
  private async meetingFor(
    user: User,
    lesson: {
      subjectId: string | null;
      startsAt: Date;
      durationMinutes: number;
    },
  ): Promise<{ provider: MeetingProvider; url: string } | null> {
    const settings = parseUserConfig(user.config).meeting;
    if (settings === null) return null;

    const created = await this.meetings.createRoom(user, settings.provider, {
      topic: await this.topicFor(user, lesson.subjectId),
      startsAt: lesson.startsAt,
      durationMinutes: lesson.durationMinutes,
    });

    return created === null
      ? meetingLinkFor(settings)
      : { provider: settings.provider, url: created };
  }

  /**
   * What the meeting is called on the provider's side.
   *
   * The subject, because that is what a person recognises in a list of Zoom
   * meetings. Deliberately not the student's name: these titles are visible in
   * an account outside the school, and a child's name does not need to be there.
   */
  private async topicFor(
    user: User,
    subjectId: string | null,
  ): Promise<string> {
    if (subjectId === null) return 'Lesson';

    const subject = await this.prisma.subject.findFirst({
      where: { id: subjectId, schoolId: user.schoolId },
      select: { name: true },
    });

    return subject?.name ?? 'Lesson';
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
      include: WITH_ATTENDEES,
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
      include: WITH_ATTENDEES,
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
