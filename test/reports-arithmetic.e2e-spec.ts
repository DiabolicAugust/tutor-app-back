import request from 'supertest';

import {
  AttendanceStatus,
  GradeKind,
  LessonStatus,
  UserRole,
} from '../generated/prisma/enums';
import {
  authHeader,
  makeGrade,
  makeGroup,
  makeGroupLesson,
  makeLesson,
  makeMarkedLesson,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

/**
 * Whether the numbers on the reports screen are true.
 *
 * The other reports spec checks that the endpoint answers the right questions
 * and refuses the wrong callers. This one is only about arithmetic, because a
 * report that is *plausible* and wrong is worse than one that fails: nobody
 * checks a number that looks reasonable, and a tutor billing from it would be
 * billing from a bug.
 *
 * Three kinds of check here, and the mix is deliberate:
 *
 * 1. **Exact figures** over a scenario counted by hand in the comments, so the
 *    expected value is derived independently of the code that produces it.
 * 2. **Cross-checks** against the endpoints the app already trusts — the
 *    calendar and a student's own progress card. Two screens that count the same
 *    weeks differently is the failure a person actually notices.
 * 3. **Invariants** — sums that have to agree with their own totals. These keep
 *    holding when somebody changes the fixtures, which fixed numbers do not.
 */

const at = (dayOffset: number, hour = 10): Date => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
};

const iso = (date: Date) => date.toISOString();

describe('Report arithmetic', () => {
  let test: TestApp;

  beforeAll(async () => {
    test = await createTestApp();
  });
  afterAll(async () => {
    await test.close();
  });
  beforeEach(async () => {
    await test.reset();
  });

  const summary = async (
    tutor: Parameters<typeof authHeader>[1],
    query: Record<string, string> = {},
  ) =>
    (
      await request(test.server)
        .get('/api/reports/summary')
        .query({ from: iso(at(-14)), to: iso(at(14)), ...query })
        .set(await authHeader(test, tutor))
        .expect(200)
    ).body;

  describe('a scenario counted by hand', () => {
    /**
     * One tutor, two students, one group of both, over a fortnight.
     *
     * Lessons, and what each contributes:
     *
     * | when  | who         | minutes | status    | counts as        |
     * | ----- | ----------- | ------- | --------- | ---------------- |
     * | -5    | Ada, Latin  | 90      | COMPLETED | 90 min, 1 lesson |
     * | -4    | Ada, Latin  | 45      | COMPLETED | 45 min, 1 lesson |
     * | -3    | Ida, Physics| 60      | COMPLETED | 60 min, 1 lesson |
     * | -2    | group, Latin| 30      | COMPLETED | 30 min, 1 lesson |
     * | -1    | Ada, Latin  | 60      | CANCELLED | nothing          |
     * | +3    | Ada, Latin  | 60      | SCHEDULED | nothing          |
     *
     * So: 6 lessons total, 4 completed, 1 cancelled, 1 scheduled.
     * Minutes taught = 90 + 45 + 60 + 30 = 225, which is 3.75 hours.
     * Latin = 90 + 45 + 30 = 165 over 3 lessons; Physics = 60 over 1.
     * Students taught = Ada and Ida = 2 (Ada appears in four lessons and in the
     * group; Ida in one lesson and in the group).
     */
    async function seed() {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school, name: 'Grace' });
      const ada = await makeStudent(test, { school, tutor, name: 'Ada' });
      const ida = await makeStudent(test, { school, tutor, name: 'Ida' });
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [ada, ida],
      });

      await makeLesson(test, {
        school,
        tutor,
        student: ada,
        startsAt: at(-5),
        subject: 'Latin',
        durationMinutes: 90,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student: ada,
        startsAt: at(-4),
        subject: 'Latin',
        durationMinutes: 45,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student: ida,
        startsAt: at(-3),
        subject: 'Physics',
        durationMinutes: 60,
        status: LessonStatus.COMPLETED,
      });
      await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: at(-2),
        subject: 'Latin',
        durationMinutes: 30,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student: ada,
        startsAt: at(-1),
        subject: 'Latin',
        durationMinutes: 60,
        status: LessonStatus.CANCELLED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student: ada,
        startsAt: at(3),
        subject: 'Latin',
        durationMinutes: 60,
        status: LessonStatus.SCHEDULED,
      });

      return { school, tutor, ada, ida };
    }

    it('counts the lessons exactly', async () => {
      const { tutor } = await seed();

      expect((await summary(tutor)).lessons).toEqual({
        total: 6,
        completed: 4,
        cancelled: 1,
        scheduled: 1,
      });
    });

    it('sums the minutes taught exactly', async () => {
      const { tutor } = await seed();

      // 90 + 45 + 60 + 30. Not the cancelled 60, not the scheduled 60.
      expect((await summary(tutor)).minutesTaught).toBe(225);
    });

    it('sums minutes rather than rounding each lesson to an hour', async () => {
      const { tutor } = await seed();
      const report = await summary(tutor);

      // 225 minutes is 3.75 hours. Rounding per lesson would give 4, and a month
      // of 45-minute lessons rounded up is a fortnight of invented work.
      expect(report.minutesTaught / 60).toBe(3.75);
    });

    it('counts each student once, group members included', async () => {
      const { tutor } = await seed();

      expect((await summary(tutor)).studentsTaught).toBe(2);
    });

    it('splits the hours by subject exactly', async () => {
      const { tutor } = await seed();

      expect((await summary(tutor)).bySubject).toEqual([
        expect.objectContaining({ name: 'Latin', lessons: 3, minutes: 165 }),
        expect.objectContaining({ name: 'Physics', lessons: 1, minutes: 60 }),
      ]);
    });
  });

  describe('the sums agree with themselves', () => {
    /** A shape neither the breakdowns nor the total can satisfy by accident. */
    async function seedVaried() {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const one = await makeUser(test, { school, name: 'One' });
      const two = await makeUser(test, { school, name: 'Two' });

      for (const [index, tutor] of [one, two, one, two, one].entries()) {
        const student = await makeStudent(test, { school, tutor });
        await makeLesson(test, {
          school,
          tutor,
          student,
          startsAt: at(-index - 1),
          subject: index % 2 === 0 ? 'Latin' : 'Physics',
          durationMinutes: 30 + index * 15,
          status: LessonStatus.COMPLETED,
        });
      }

      // One cancelled, so a breakdown that included it would break the invariant
      // rather than pass by coincidence.
      const spare = await makeStudent(test, { school, tutor: one });
      await makeLesson(test, {
        school,
        tutor: one,
        student: spare,
        startsAt: at(-8),
        durationMinutes: 90,
        status: LessonStatus.CANCELLED,
      });

      return { admin };
    }

    it('breaks the same minutes down by subject as it reports in total', async () => {
      const { admin } = await seedVaried();
      const report = await summary(admin);

      const bySubject = report.bySubject.reduce(
        (total: number, row: { minutes: number }) => total + row.minutes,
        0,
      );
      expect(bySubject).toBe(report.minutesTaught);
    });

    it('breaks the same minutes down by tutor as it reports in total', async () => {
      const { admin } = await seedVaried();
      const report = await summary(admin);

      const byTutor = report.byTutor.reduce(
        (total: number, row: { minutes: number }) => total + row.minutes,
        0,
      );
      expect(byTutor).toBe(report.minutesTaught);
    });

    it('counts the same lessons in both breakdowns as it completed', async () => {
      const { admin } = await seedVaried();
      const report = await summary(admin);

      const count = (rows: { lessons: number }[]) =>
        rows.reduce((total, row) => total + row.lessons, 0);

      expect(count(report.bySubject as { lessons: number }[])).toBe(
        report.lessons.completed,
      );
      expect(count(report.byTutor as { lessons: number }[])).toBe(
        report.lessons.completed,
      );
    });

    it('never reports more of one status than there are lessons', async () => {
      const { admin } = await seedVaried();
      const { lessons } = await summary(admin);

      expect(lessons.completed + lessons.cancelled + lessons.scheduled).toBe(
        lessons.total,
      );
    });
  });

  describe('it agrees with the screens it summarises', () => {
    it('reports the lessons the calendar shows, and no others', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      for (const day of [-6, -4, -2, 1, 3]) {
        await makeLesson(test, {
          school,
          tutor,
          student,
          startsAt: at(day),
          durationMinutes: 45,
          status: day < 0 ? LessonStatus.COMPLETED : LessonStatus.SCHEDULED,
        });
      }

      const window = { from: iso(at(-7)), to: iso(at(7)) };
      const header = await authHeader(test, tutor);

      // The same window, asked of the calendar. Counted here rather than
      // hard-coded, so this stays a comparison between two endpoints rather than
      // a restatement of one of them.
      const { body: calendar } = await request(test.server)
        .get('/api/lessons')
        .query(window)
        .set(header)
        .expect(200);

      const report = await summary(tutor, window);

      const completed = calendar.filter(
        (lesson: { status: string }) => lesson.status === 'COMPLETED',
      );
      expect(report.lessons.total).toBe(calendar.length);
      expect(report.lessons.completed).toBe(completed.length);
      expect(report.minutesTaught).toBe(
        completed.reduce(
          (total: number, lesson: { durationMinutes: number }) =>
            total + lesson.durationMinutes,
          0,
        ),
      );
    });

    it("reports attendance the way the student's own progress card does", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const marks = [
        AttendanceStatus.PRESENT,
        AttendanceStatus.PRESENT,
        AttendanceStatus.LATE,
        AttendanceStatus.ABSENT_UNEXCUSED,
      ];
      for (const [index, attendance] of marks.entries()) {
        await makeMarkedLesson(test, {
          school,
          tutor,
          student,
          startsAt: at(-index - 1),
          attendance,
        });
      }

      const header = await authHeader(test, tutor);
      const { body: progress } = await request(test.server)
        .get(`/api/students/${student.id}/progress`)
        .set(header)
        .expect(200);

      const report = await summary(tutor);

      // The only student in the school, so the two must agree exactly. If they
      // ever disagree, one screen is lying to somebody about the same weeks.
      expect(report.attendance).toEqual(progress.attendance);
      // And the arithmetic itself: three of four attended, counting the late one.
      expect(report.attendance.rate).toBe(0.75);
    });
  });

  describe('marks', () => {
    it('weighs them instead of averaging flat', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeGrade(test, { student, author: tutor, value: 12, weight: 3 });
      await makeGrade(test, { student, author: tutor, value: 4, weight: 1 });

      // (12*3 + 4*1) / (3+1) = 10. A flat mean would say 8, and a term test
      // weighing the same as a vocabulary quiz is the whole reason weight exists.
      expect((await summary(tutor)).grades.classic.average).toBe(10);
    });

    it('never mixes a scale mark with a percentage', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.CLASSIC,
        value: 5,
      });
      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.PERCENTAGE,
        value: 90,
      });

      const { grades } = await summary(tutor);

      // A 5 out of 12 and 90% averaged together is a number that means nothing.
      expect(grades.classic.average).toBe(5);
      expect(grades.percentage.average).toBe(90);
      expect(grades.count).toBe(2);
    });

    it('counts a written mark without letting it into an average', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.CLASSIC,
        value: 8,
      });
      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.DESCRIPTIVE,
        comment: 'Reads aloud with confidence now',
      });

      const { grades } = await summary(tutor);

      expect(grades.classic.average).toBe(8);
      expect(grades.classic.count).toBe(1);
      expect(grades.descriptiveCount).toBe(1);
      expect(grades.count).toBe(2);
    });

    it('says nothing rather than zero when there is nothing to average', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const { grades } = await summary(tutor);

      // Null, not 0: "no marks" and "everyone scored nothing" are opposite facts.
      expect(grades.classic).toBeNull();
      expect(grades.percentage).toBeNull();
      expect(grades.count).toBe(0);
    });

    it("counts a colleague's marks in the school's report but not in a tutor's own", async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeGrade(test, { student, author: tutor, value: 10 });
      await makeGrade(test, { student, author: colleague, value: 2 });

      expect((await summary(tutor)).grades.count).toBe(1);
      expect((await summary(admin)).grades.count).toBe(2);
      // The school average is over both, and only the school's.
      expect((await summary(admin)).grades.classic.average).toBe(6);
    });
  });

  describe('attendance', () => {
    it('treats a late arrival as taught', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        attendance: AttendanceStatus.LATE,
      });

      const { attendance } = await summary(tutor);

      // They were in the lesson. The distinction is kept in its own field for
      // whoever cares about punctuality, and does not distort the headline.
      expect(attendance.rate).toBe(1);
      expect(attendance.late).toBe(1);
      expect(attendance.present).toBe(0);
    });

    it('counts one row per student in a group, not one per lesson', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const ada = await makeStudent(test, { school, tutor, name: 'Ada' });
      const ida = await makeStudent(test, { school, tutor, name: 'Ida' });
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [ada, ida],
      });
      const lesson = await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      await test.prisma.lessonAttendance.createMany({
        data: [
          {
            lessonId: lesson.id,
            studentId: ada.id,
            status: AttendanceStatus.PRESENT,
          },
          {
            lessonId: lesson.id,
            studentId: ida.id,
            status: AttendanceStatus.ABSENT_UNEXCUSED,
          },
        ],
      });

      const { attendance } = await summary(tutor);

      // One lesson, two people, one of whom came: half, not all and not none.
      expect(attendance.marked).toBe(2);
      expect(attendance.rate).toBe(0.5);
    });

    it('says nothing rather than nought per cent when nothing is marked', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { attendance } = await summary(tutor);

      // A 0% attendance badge on a tutor who simply has not filled the register
      // in is a lie about their students.
      expect(attendance.rate).toBeNull();
      expect(attendance.marked).toBe(0);
    });
  });

  describe('the window', () => {
    it('includes a lesson exactly at the start and excludes one at the end', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const from = at(-3);
      const to = at(-1);

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: from,
        durationMinutes: 30,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: to,
        durationMinutes: 30,
        status: LessonStatus.COMPLETED,
      });

      const report = await summary(tutor, { from: iso(from), to: iso(to) });

      // Half-open, like every other range in this codebase: two reports over
      // adjoining windows must not both count the lesson on the boundary.
      expect(report.lessons.total).toBe(1);
      expect(report.minutesTaught).toBe(30);
    });

    it('does not double count a lesson across adjoining windows', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      for (const day of [-6, -4, -2]) {
        await makeLesson(test, {
          school,
          tutor,
          student,
          startsAt: at(day),
          durationMinutes: 60,
          status: LessonStatus.COMPLETED,
        });
      }

      const first = await summary(tutor, {
        from: iso(at(-7)),
        to: iso(at(-3)),
      });
      const second = await summary(tutor, {
        from: iso(at(-3)),
        to: iso(at(0)),
      });
      const whole = await summary(tutor, { from: iso(at(-7)), to: iso(at(0)) });

      expect(first.lessons.total + second.lessons.total).toBe(
        whole.lessons.total,
      );
      expect(first.minutesTaught + second.minutesTaught).toBe(
        whole.minutesTaught,
      );
    });

    it('leaves out marks given outside the window', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const old = await makeGrade(test, { student, author: tutor, value: 3 });
      await test.prisma.grade.update({
        where: { id: old.id },
        data: { createdAt: at(-40) },
      });
      await makeGrade(test, { student, author: tutor, value: 11 });

      const { grades } = await summary(tutor, {
        from: iso(at(-7)),
        to: iso(at(1)),
      });

      expect(grades.count).toBe(1);
      expect(grades.classic.average).toBe(11);
    });
  });

  describe('what belongs to somebody else', () => {
    it("leaves another school's work out of every figure", async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const mine = await makeStudent(test, { school, tutor });

      await makeMarkedLesson(test, {
        school,
        tutor,
        student: mine,
        startsAt: at(-1),
        attendance: AttendanceStatus.PRESENT,
      });
      await makeGrade(test, { student: mine, author: tutor, value: 9 });

      // A whole second school, doing more of everything.
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });
      const theirs = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });
      for (const day of [-3, -2, -1]) {
        await makeMarkedLesson(test, {
          school: other,
          tutor: stranger,
          student: theirs,
          startsAt: at(day),
          attendance: AttendanceStatus.ABSENT_UNEXCUSED,
        });
        await makeGrade(test, { student: theirs, author: stranger, value: 1 });
      }

      const report = await summary(admin);

      expect(report.lessons.total).toBe(1);
      expect(report.studentsTaught).toBe(1);
      expect(report.attendance.marked).toBe(1);
      expect(report.attendance.rate).toBe(1);
      expect(report.grades.count).toBe(1);
      expect(report.grades.classic.average).toBe(9);
    });
  });
});
