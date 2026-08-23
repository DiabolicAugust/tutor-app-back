import request from 'supertest';

import { LessonStatus, UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeLesson,
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

describe('Lessons', () => {
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

  describe('booking', () => {
    it("always books onto the caller's own calendar", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const response = await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: student.id,
          subject: 'Algebra',
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        tutorId: tutor.id,
        studentId: student.id,
        schoolId: school.id,
        status: LessonStatus.SCHEDULED,
      });
    });

    it("refuses to book for a colleague's student", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: theirs.id,
          subject: 'Algebra',
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(403);
    });

    it('refuses to book for a student in another school', async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const stranger = await makeUser(test, { school: other });
      const elsewhere = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: elsewhere.id,
          subject: 'Algebra',
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(404);
    });

    it('rejects a duration outside what a lesson can plausibly be', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: student.id,
          subject: 'Algebra',
          startsAt: at(1).toISOString(),
          durationMinutes: 1,
        })
        .expect(400);
    });
  });

  describe('the calendar view', () => {
    it('returns only what falls inside the requested window', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(1),
        subject: 'Inside',
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(40),
        subject: 'Outside',
      });

      const response = await request(test.server)
        .get('/api/lessons')
        .query({ from: at(0).toISOString(), to: at(7).toISOString() })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Inside',
      ]);
    });

    it('returns them in the order the day is read', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(1, 16),
        subject: 'Later',
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(1, 9),
        subject: 'Earlier',
      });

      const response = await request(test.server)
        .get('/api/lessons')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Earlier',
        'Later',
      ]);
    });

    it('includes the student name, which is what the calendar renders', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor, name: 'Petro' });
      await makeLesson(test, { school, tutor, student, startsAt: at(1) });

      const response = await request(test.server)
        .get('/api/lessons')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body[0].student).toEqual({
        id: student.id,
        name: 'Petro',
      });
    });

    it('shows a tutor their own calendar by default', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const mine = await makeStudent(test, { school, tutor });
      const theirs = await makeStudent(test, { school, tutor: colleague });
      await makeLesson(test, {
        school,
        tutor,
        student: mine,
        startsAt: at(1),
        subject: 'Mine',
      });
      await makeLesson(test, {
        school,
        tutor: colleague,
        student: theirs,
        startsAt: at(1),
        subject: 'Theirs',
      });

      const response = await request(test.server)
        .get('/api/lessons')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Mine',
      ]);
    });

    it("lets a tutor add a colleague's calendar through the filter", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });
      await makeLesson(test, {
        school,
        tutor: colleague,
        student: theirs,
        startsAt: at(1),
        subject: 'Theirs',
      });

      const response = await request(test.server)
        .get('/api/lessons')
        .query({ tutorIds: `${tutor.id},${colleague.id}` })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Theirs',
      ]);
    });

    it('does not let the filter reach into another school', async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const stranger = await makeUser(test, { school: other });
      const elsewhere = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });
      await makeLesson(test, {
        school: other,
        tutor: stranger,
        student: elsewhere,
        startsAt: at(1),
      });

      // Tenant isolation is applied before the filter narrows anything, so
      // naming a stranger id buys nothing.
      const response = await request(test.server)
        .get('/api/lessons')
        .query({ tutorIds: stranger.id })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('shows an admin the whole school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, { school, tutor, student, startsAt: at(1) });

      const response = await request(test.server)
        .get('/api/lessons')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });
  });

  describe('confirming a lesson', () => {
    it("spends one lesson from the student's package", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        paidLessonsLeft: 4,
      });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(await authHeader(test, tutor))
        .send({ status: LessonStatus.COMPLETED })
        .expect(200);

      const after = await test.prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      expect(after.paidLessonsLeft).toBe(3);
    });

    it('does not spend a second one when confirmed twice', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        paidLessonsLeft: 4,
      });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });
      const header = await authHeader(test, tutor);

      for (let i = 0; i < 2; i++) {
        await request(test.server)
          .patch(`/api/lessons/${lesson.id}/status`)
          .set(header)
          .send({ status: LessonStatus.COMPLETED })
          .expect(200);
      }

      // A double tap on a slow connection must not cost the student twice.
      const after = await test.prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      expect(after.paidLessonsLeft).toBe(3);
    });

    it('spends nothing when the lesson is cancelled', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        paidLessonsLeft: 4,
      });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(await authHeader(test, tutor))
        .send({ status: LessonStatus.CANCELLED })
        .expect(200);

      const after = await test.prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      expect(after.paidLessonsLeft).toBe(4);
    });

    it('lets an admin confirm a lesson they did not teach', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(await authHeader(test, admin))
        .send({ status: LessonStatus.COMPLETED })
        .expect(200);
    });

    it("hides a colleague's lesson from a tutor behind a 404", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });
      const lesson = await makeLesson(test, {
        school,
        tutor: colleague,
        student: theirs,
        startsAt: at(-1),
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(await authHeader(test, tutor))
        .send({ status: LessonStatus.COMPLETED })
        .expect(404);
    });

    it('rejects a status that is not one a lesson can be in', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(await authHeader(test, tutor))
        .send({ status: 'RESCHEDULED' })
        .expect(400);
    });
  });

  describe("a student's history", () => {
    it('reads newest first, the opposite of the calendar', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-7),
        subject: 'Older',
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        subject: 'Recent',
      });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Recent',
        'Older',
      ]);
    });

    it('includes lessons already past, which a date window would have dropped', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, { school, tutor, student, startsAt: at(-90) });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('says whether each lesson happened, and whether anybody wrote it up', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
      });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/status`)
        .set(header)
        .send({ status: LessonStatus.COMPLETED })
        .expect(200);
      await request(test.server)
        .post(`/api/lessons/${lesson.id}/notes`)
        .set(header)
        .send({ text: 'Went well' })
        .expect(201);

      const response = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(header)
        .expect(200);

      // The count is what the list shows without opening anything.
      expect(response.body[0]).toMatchObject({
        status: LessonStatus.COMPLETED,
        _count: { notes: 1 },
      });
    });

    it("holds only that student's lessons", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const other = await makeStudent(test, { school, tutor });
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        subject: 'Theirs',
      });
      await makeLesson(test, {
        school,
        tutor,
        student: other,
        startsAt: at(-1),
        subject: 'Other',
      });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((l: { subject: string }) => l.subject)).toEqual([
        'Theirs',
      ]);
    });

    it("is refused for a colleague's student", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      await request(test.server)
        .get(`/api/students/${theirs.id}/lessons`)
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('is open to an admin for anybody in their school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, { school, tutor, student, startsAt: at(-1) });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });
  });
});
