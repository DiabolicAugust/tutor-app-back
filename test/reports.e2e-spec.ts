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

/** Fixed offsets from a fixed point, so no test depends on the hour it runs at. */
const at = (dayOffset: number, hour = 10): Date => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
};

const iso = (date: Date) => date.toISOString();

describe('Reports', () => {
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

  describe('what a tutor gets', () => {
    it('counts the hours actually taught, and not the ones planned', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-3),
        durationMinutes: 90,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-2),
        durationMinutes: 60,
        status: LessonStatus.CANCELLED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(2),
        durationMinutes: 60,
        status: LessonStatus.SCHEDULED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .query({ from: iso(at(-7)), to: iso(at(7)) })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.lessons).toEqual({
        total: 3,
        completed: 1,
        cancelled: 1,
        scheduled: 1,
      });
      // The number somebody bills from: only the lesson that happened.
      expect(body.minutesTaught).toBe(90);
    });

    it("leaves out a colleague's work entirely", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const mine = await makeStudent(test, { school, tutor });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      await makeLesson(test, {
        school,
        tutor,
        student: mine,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor: colleague,
        student: theirs,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.lessons.completed).toBe(1);
      expect(body.scope).toEqual({ tutorId: tutor.id });
      // No per-tutor table at all: there is only one tutor in this report, and
      // naming colleagues here would be a roster the students screen hides.
      expect(body.byTutor).toBeNull();
    });

    it('cannot ask about somebody else', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });

      await request(test.server)
        .get('/api/reports/summary')
        .query({ tutorId: colleague.id })
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('may name itself, which is what the app sends', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .get('/api/reports/summary')
        .query({ tutorId: tutor.id })
        .set(await authHeader(test, tutor))
        .expect(200);
    });
  });

  describe('what an admin gets', () => {
    it('covers the school, and breaks it down by tutor', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const one = await makeUser(test, { school, name: 'Ada' });
      const two = await makeUser(test, { school, name: 'Grace' });
      const hers = await makeStudent(test, { school, tutor: one });
      const theirs = await makeStudent(test, { school, tutor: two });

      await makeLesson(test, {
        school,
        tutor: one,
        student: hers,
        startsAt: at(-1),
        durationMinutes: 120,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor: two,
        student: theirs,
        startsAt: at(-1),
        durationMinutes: 30,
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(body.scope).toEqual({ tutorId: null });
      expect(body.lessons.completed).toBe(2);
      // Busiest first — the order the screen renders without sorting again.
      expect(body.byTutor.map((row: { name: string }) => row.name)).toEqual([
        'Ada',
        'Grace',
      ]);
      expect(body.byTutor[0].minutes).toBe(120);
    });

    it('can narrow to one tutor', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const one = await makeUser(test, { school });
      const two = await makeUser(test, { school });
      const hers = await makeStudent(test, { school, tutor: one });
      const theirs = await makeStudent(test, { school, tutor: two });

      await makeLesson(test, {
        school,
        tutor: one,
        student: hers,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor: two,
        student: theirs,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .query({ tutorId: one.id })
        .set(await authHeader(test, admin))
        .expect(200);

      expect(body.lessons.completed).toBe(1);
      expect(body.scope).toEqual({ tutorId: one.id });
    });

    it('sees nothing of another school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });
      const theirs = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });

      await makeLesson(test, {
        school: other,
        tutor: stranger,
        student: theirs,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(body.lessons.total).toBe(0);
    });
  });

  describe('the numbers themselves', () => {
    it('counts attendance the way the gradebook does', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-3),
        attendance: AttendanceStatus.PRESENT,
      });
      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-2),
        attendance: AttendanceStatus.LATE,
      });
      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        attendance: AttendanceStatus.ABSENT_UNEXCUSED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.attendance.marked).toBe(3);
      // Late counts as taught, exactly as on a student's own progress screen.
      // One definition, or the two screens disagree in front of the same person.
      expect(body.attendance.rate).toBeCloseTo(2 / 3, 2);
    });

    it('weighs marks rather than averaging them flat', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.CLASSIC,
        value: 12,
        weight: 3,
      });
      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.CLASSIC,
        value: 4,
        weight: 1,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      // (12*3 + 4*1) / 4 = 10, not the flat 8.
      expect(body.grades.classic.average).toBe(10);
    });

    it('counts the people in a group, not the group', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const one = await makeStudent(test, { school, tutor, name: 'A' });
      const two = await makeStudent(test, { school, tutor, name: 'B' });
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [one, two],
      });

      await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      // One lesson, two students taught. Reporting "1 student" for a group of
      // two is the mistake this is here to prevent.
      expect(body.lessons.completed).toBe(1);
      expect(body.studentsTaught).toBe(2);
    });

    it('counts a student once however many lessons they had', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-3),
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-2),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.studentsTaught).toBe(1);
    });

    it('groups the hours by subject', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-3),
        subject: 'Latin',
        durationMinutes: 60,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-2),
        subject: 'Latin',
        durationMinutes: 60,
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        subject: 'Physics',
        durationMinutes: 45,
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.bySubject).toEqual([
        expect.objectContaining({ name: 'Latin', lessons: 2, minutes: 120 }),
        expect.objectContaining({ name: 'Physics', lessons: 1, minutes: 45 }),
      ]);
    });
  });

  describe('the window', () => {
    it('leaves out what falls outside it', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-40),
        status: LessonStatus.COMPLETED,
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        status: LessonStatus.COMPLETED,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .query({ from: iso(at(-7)), to: iso(at(1)) })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(body.lessons.completed).toBe(1);
    });

    it('refuses one that ends before it starts', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .get('/api/reports/summary')
        .query({ from: iso(at(5)), to: iso(at(1)) })
        .set(await authHeader(test, tutor))
        .expect(400);
    });

    it('refuses one wide enough to read the whole database', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .get('/api/reports/summary')
        .query({
          from: '1970-01-01T00:00:00.000Z',
          to: '2100-01-01T00:00:00.000Z',
        })
        .set(await authHeader(test, tutor))
        .expect(400);
    });
  });

  it('is not readable without signing in', async () => {
    await request(test.server).get('/api/reports/summary').expect(401);
  });
});
