import request from 'supertest';

import type { User } from '../generated/prisma/client';

import {
  LessonStatus,
  MeetingProvider,
  UserRole,
} from '../generated/prisma/enums';
import {
  authHeader,
  makeGroup,
  makeGroupLesson,
  makeLesson,
  makeSchool,
  makeStudent,
  makeSubject,
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
      const algebra = await makeSubject(test, { school, name: 'Algebra' });

      const response = await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: student.id,
          subjectId: algebra.id,
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
      const algebra = await makeSubject(test, { school, name: 'Algebra' });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: theirs.id,
          subjectId: algebra.id,
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
      // The caller's own subject, so the 404 can only be about the student.
      const algebra = await makeSubject(test, { school, name: 'Algebra' });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: elsewhere.id,
          subjectId: algebra.id,
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(404);
    });

    it('rejects a duration outside what a lesson can plausibly be', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const algebra = await makeSubject(test, { school, name: 'Algebra' });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: student.id,
          subjectId: algebra.id,
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Inside']);
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Earlier', 'Later']);
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Mine']);
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Theirs']);
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
    it("leaves the student's balance alone, because charging follows the register", async () => {
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

      // Moving a lesson in the schedule is not the same act as saying who came,
      // and since a group lesson charges only the people who turned up, charging
      // lives in exactly one place: the register. See the Gradebook suite.
      const after = await test.prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      expect(after.paidLessonsLeft).toBe(4);
    });

    it('stays put when confirmed twice', async () => {
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

      const after = await test.prisma.student.findUniqueOrThrow({
        where: { id: student.id },
      });
      expect(after.paidLessonsLeft).toBe(4);
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Recent', 'Older']);
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

      expect(
        response.body.map((l: { subject: { name: string } }) => l.subject.name),
      ).toEqual(['Theirs']);
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

  describe('booking for a group', () => {
    async function seedGroup() {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const [ann, bob] = await Promise.all([
        makeStudent(test, { school, tutor, name: 'Ann' }),
        makeStudent(test, { school, tutor, name: 'Bob' }),
      ]);
      const group = await makeGroup(test, {
        school,
        tutor,
        name: 'B1 Tuesdays',
        members: [ann, bob],
      });
      // The same row `makeGroup` just used, read back so the bookings below can
      // name it by id.
      const english = await makeSubject(test, { school, name: 'English' });

      return { school, tutor, ann, bob, group, english };
    }

    it('books onto the group rather than any one student', async () => {
      const { tutor, group, english } = await seedGroup();

      const response = await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          groupId: group.id,
          subjectId: english.id,
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        studentId: null,
        groupId: group.id,
      });
      // The members come with the lesson, so the calendar can expand a group
      // block without a second request.
      expect(response.body.group.members).toHaveLength(2);
    });

    it('refuses a lesson for neither a student nor a group', async () => {
      const { tutor, english } = await seedGroup();

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          subjectId: english.id,
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(400);
    });

    it('refuses a lesson for both at once', async () => {
      const { tutor, ann, group, english } = await seedGroup();

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          studentId: ann.id,
          groupId: group.id,
          subjectId: english.id,
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(400);
    });

    it("refuses a colleague's group", async () => {
      const { school, tutor, english } = await seedGroup();
      const colleague = await makeUser(test, { school });
      const theirs = await makeGroup(test, { school, tutor: colleague });

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, tutor))
        .send({
          groupId: theirs.id,
          subjectId: english.id,
          startsAt: at(1).toISOString(),
          durationMinutes: 60,
        })
        .expect(404);
    });

    it("appears on each member's page in the tutor's app", async () => {
      const { school, tutor, ann, bob, group } = await seedGroup();
      const lesson = await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: at(-1),
      });

      // `GET /students/:id/lessons` backs the student detail screen the *tutor*
      // opens — students have no accounts here. A group lesson has to show up
      // there, because otherwise a member's history would silently omit most of
      // what they were taught.
      for (const student of [ann, bob]) {
        const response = await request(test.server)
          .get(`/api/students/${student.id}/lessons`)
          .set(await authHeader(test, tutor))
          .expect(200);

        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
          id: lesson.id,
          studentId: null,
        });
        expect(response.body[0].group.name).toBe('B1 Tuesdays');
      }
    });

    it('drops off that page once the student leaves the group', async () => {
      const { school, tutor, ann, group } = await seedGroup();
      await makeGroupLesson(test, { school, tutor, group, startsAt: at(-1) });

      await test.prisma.groupMember.deleteMany({
        where: { groupId: group.id, studentId: ann.id },
      });

      const response = await request(test.server)
        .get(`/api/students/${ann.id}/lessons`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(0);
    });
  });

  describe('what a single request may ask for', () => {
    it('refuses a window wider than a year and a bit', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      // The window was always required, which is not the same as bounded. This
      // asks for every lesson a school has ever had, each with its group's whole
      // membership attached, from an ordinary account.
      await request(test.server)
        .get('/api/lessons')
        .query({
          from: '1970-01-01T00:00:00.000Z',
          to: '2100-01-01T00:00:00.000Z',
        })
        .set(await authHeader(test, tutor))
        .expect(400);
    });

    it('refuses a window that ends before it starts', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .get('/api/lessons')
        .query({ from: at(5).toISOString(), to: at(1).toISOString() })
        .set(await authHeader(test, tutor))
        .expect(400);
    });

    it('still serves the window the calendar actually asks for', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, { school, tutor, student, startsAt: at(3) });

      const response = await request(test.server)
        .get('/api/lessons')
        .query({ from: at(0).toISOString(), to: at(31).toISOString() })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('refuses more calendars in one request than a school has people', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const many = Array.from(
        { length: 60 },
        (_, index) => `tutor-${index}`,
      ).join(',');

      await request(test.server)
        .get('/api/lessons')
        .query({ tutorIds: many })
        .set(await authHeader(test, tutor))
        .expect(400);
    });
  });

  describe('the link to join', () => {
    /** Puts a tutor on a provider, the way the settings screen would. */
    const teachesOn = (
      test: TestApp,
      tutor: { id: string },
      meeting: { provider: MeetingProvider; roomUrl: string | null } | null,
    ) =>
      test.prisma.user.update({
        where: { id: tutor.id },
        data: { config: { meeting } },
      });

    const book = async (tutor: User, student: { id: string }) =>
      (
        await request(test.server)
          .post('/api/lessons')
          .set(await authHeader(test, tutor))
          .send({
            studentId: student.id,
            startsAt: at(1).toISOString(),
            durationMinutes: 60,
          })
          .expect(201)
      ).body;

    it('is absent for a tutor who teaches in a room', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const lesson = await book(tutor, student);

      // Null rather than an empty string: nothing to join is not a blank link.
      expect(lesson.meetingUrl).toBeNull();
      expect(lesson.meetingProvider).toBeNull();
    });

    it('is a fresh room for every lesson, on a provider that makes them', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await teachesOn(test, tutor, {
        provider: MeetingProvider.JITSI,
        roomUrl: null,
      });

      const first = await book(tutor, student);
      const second = await book(tutor, student);

      expect(first.meetingProvider).toBe(MeetingProvider.JITSI);
      expect(first.meetingUrl).toContain('https://meet.jit.si/');
      // Two lessons sharing a room would drop one class into another's call.
      expect(first.meetingUrl).not.toBe(second.meetingUrl);
    });

    it("is the tutor's own room, on a provider that reuses one", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await teachesOn(test, tutor, {
        provider: MeetingProvider.ZOOM,
        roomUrl: 'https://myschool.zoom.us/j/9876543210',
      });

      const lesson = await book(tutor, student);

      expect(lesson).toMatchObject({
        meetingProvider: MeetingProvider.ZOOM,
        meetingUrl: 'https://myschool.zoom.us/j/9876543210',
      });
    });

    it('does not change under a lesson that is already booked', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      await teachesOn(test, tutor, {
        provider: MeetingProvider.ZOOM,
        roomUrl: 'https://zoom.us/j/111',
      });

      const booked = await book(tutor, student);
      // The tutor moves providers in March. February's lessons must not start
      // claiming to be somewhere they were never held, and a link already sent
      // to a student has to keep meaning what it meant.
      await teachesOn(test, tutor, {
        provider: MeetingProvider.JITSI,
        roomUrl: null,
      });

      const { body } = await request(test.server)
        .get('/api/lessons')
        .query({ from: at(0).toISOString(), to: at(2).toISOString() })
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(
        body.find((l: { id: string }) => l.id === booked.id),
      ).toMatchObject({
        meetingProvider: MeetingProvider.ZOOM,
        meetingUrl: 'https://zoom.us/j/111',
      });
    });

    it('is not created from settings an older build stored', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      // http, which this build refuses. Better no link than one that fails in
      // front of a student.
      await teachesOn(test, tutor, {
        provider: MeetingProvider.ZOOM,
        roomUrl: 'http://zoom.us/j/1',
      });

      const lesson = await book(tutor, student);

      expect(lesson.meetingUrl).toBeNull();
    });
  });
});
