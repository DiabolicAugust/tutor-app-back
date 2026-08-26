import request from 'supertest';

import {
  AttendanceStatus,
  LessonStatus,
  UserRole,
} from '../generated/prisma/enums';
import {
  authHeader,
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
 * Who has run out of paid lessons.
 *
 * The balance itself is not new — the register has always spent it — so most of
 * what matters here is which students the list *leaves out*. A screen that names
 * everybody is one nobody reads, and the two ways to get that wrong are
 * including a student who has simply never been charged, and including one whose
 * package ran out months ago and who is not coming back.
 */

const at = (dayOffset: number, hour = 10): Date => {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date;
};

describe('Debtors', () => {
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

  const list = async (
    user: Parameters<typeof authHeader>[1],
    query: Record<string, string> = {},
  ) =>
    (
      await request(test.server)
        .get('/api/reports/debtors')
        .query(query)
        .set(await authHeader(test, user))
        .expect(200)
    ).body;

  /** A student with a balance, and optionally a lesson still booked. */
  async function studentOwing(
    school: Awaited<ReturnType<typeof makeSchool>>,
    tutor: Awaited<ReturnType<typeof makeUser>>,
    options: { name: string; balance: number; booked?: number },
  ) {
    const student = await makeStudent(test, {
      school,
      tutor,
      name: options.name,
      paidLessonsLeft: options.balance,
    });

    for (let index = 0; index < (options.booked ?? 0); index += 1) {
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(index + 1),
        status: LessonStatus.SCHEDULED,
      });
    }

    return student;
  }

  describe('who is on it', () => {
    it('names a student who has been taught beyond their package', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await studentOwing(school, tutor, { name: 'Ada', balance: -2 });

      const [row, ...rest] = await list(tutor);

      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        name: 'Ada',
        paidLessonsLeft: -2,
        lessonsOwed: 2,
      });
    });

    it('names a student at exactly zero who has another lesson booked', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await studentOwing(school, tutor, {
        name: 'Ida',
        balance: 0,
        booked: 1,
      });

      const [row] = await list(tutor);

      // Nothing owed yet, and that is the moment worth catching: the next lesson
      // is the one that goes unpaid.
      expect(row).toMatchObject({
        name: 'Ida',
        lessonsOwed: 0,
        lessonsBooked: 1,
      });
    });

    it('leaves out a student who has simply never been charged', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      // A free trial, or a name someone added yesterday. Zero because nobody has
      // ever bought them a package, not because they owe anything.
      await studentOwing(school, tutor, { name: 'Nobody', balance: 0 });

      expect(await list(tutor)).toEqual([]);
    });

    it('leaves out a student with lessons left', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await studentOwing(school, tutor, {
        name: 'Paid Up',
        balance: 4,
        booked: 2,
      });

      expect(await list(tutor)).toEqual([]);
    });

    it('can be asked one lesson earlier, for a warning', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await studentOwing(school, tutor, {
        name: 'Nearly Out',
        balance: 1,
        booked: 1,
      });

      expect(await list(tutor)).toEqual([]);

      const warned = await list(tutor, { atOrBelow: '1' });
      expect(warned).toHaveLength(1);
      expect(warned[0]).toMatchObject({ name: 'Nearly Out', lessonsOwed: 0 });
    });

    it('cannot be used to ask for the whole roster', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      // A large enough threshold would return every student, which is a
      // different screen with different permissions.
      await request(test.server)
        .get('/api/reports/debtors')
        .query({ atOrBelow: '10000' })
        .set(await authHeader(test, tutor))
        .expect(400);
    });
  });

  describe('the order', () => {
    it('puts the deepest debt first, then whoever has most booked', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await studentOwing(school, tutor, { name: 'One Behind', balance: -1 });
      await studentOwing(school, tutor, { name: 'Three Behind', balance: -3 });
      await studentOwing(school, tutor, {
        name: 'One Behind But Booked',
        balance: -1,
        booked: 2,
      });

      const names = (await list(tutor)).map(
        (row: { name: string }) => row.name,
      );

      // The order is the point of the screen: it answers who to speak to first.
      expect(names).toEqual([
        'Three Behind',
        'One Behind But Booked',
        'One Behind',
      ]);
    });
  });

  describe('what each row says', () => {
    it('counts a group lesson as booked for everybody in the room', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const ada = await studentOwing(school, tutor, {
        name: 'Ada',
        balance: -1,
      });
      const ida = await studentOwing(school, tutor, {
        name: 'Ida',
        balance: -1,
      });
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [ada, ida],
      });
      await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: at(2),
        status: LessonStatus.SCHEDULED,
      });

      const rows = await list(tutor);

      // Both of them are about to owe another lesson, not just the group.
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.lessonsBooked).toBe(1);
    });

    it('says when they were last actually taught', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        name: 'Ada',
        paidLessonsLeft: -1,
      });

      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-9),
        attendance: AttendanceStatus.PRESENT,
      });
      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-2),
        attendance: AttendanceStatus.PRESENT,
      });
      // Never written up, so it did not happen as far as anybody knows.
      await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        status: LessonStatus.SCHEDULED,
      });

      const [row] = await list(tutor);

      expect(new Date(row.lastTaughtAt as string).toISOString()).toBe(
        at(-2).toISOString(),
      );
    });

    it('says nothing rather than a date when nobody has written a lesson up', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await studentOwing(school, tutor, { name: 'Ada', balance: -1 });

      const [row] = await list(tutor);

      expect(row.lastTaughtAt).toBeNull();
    });
  });

  describe('who may see it', () => {
    it("shows a tutor their own students and nobody else's", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      await studentOwing(school, tutor, { name: 'Mine', balance: -1 });
      await studentOwing(school, colleague, { name: 'Theirs', balance: -5 });

      const names = (await list(tutor)).map(
        (row: { name: string }) => row.name,
      );

      expect(names).toEqual(['Mine']);
    });

    it('shows an admin the school, and says whose student each is', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const one = await makeUser(test, { school, name: 'Grace' });
      const two = await makeUser(test, { school, name: 'Ada' });
      await studentOwing(school, one, { name: 'Hers', balance: -1 });
      await studentOwing(school, two, { name: 'Theirs', balance: -2 });

      const rows = await list(admin);

      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ name: 'Theirs', tutorName: 'Ada' });
      expect(rows[1]).toMatchObject({ name: 'Hers', tutorName: 'Grace' });
    });

    it('refuses a tutor asking about a colleague', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });

      await request(test.server)
        .get('/api/reports/debtors')
        .query({ tutorId: colleague.id })
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('lets an admin narrow to one tutor', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const one = await makeUser(test, { school });
      const two = await makeUser(test, { school });
      await studentOwing(school, one, { name: 'Hers', balance: -1 });
      await studentOwing(school, two, { name: 'Theirs', balance: -2 });

      const rows = await list(admin, { tutorId: one.id });

      expect(rows.map((row: { name: string }) => row.name)).toEqual(['Hers']);
    });

    it("never shows another school's students", async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });
      await studentOwing(other, stranger, { name: 'Elsewhere', balance: -9 });

      expect(await list(admin)).toEqual([]);
    });

    it('is not readable without signing in', async () => {
      await request(test.server).get('/api/reports/debtors').expect(401);
    });
  });

  describe('it follows the register', () => {
    it('appears once a lesson has been marked beyond the package', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        paidLessonsLeft: 0,
      });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        status: LessonStatus.SCHEDULED,
      });

      // Not there yet: nothing owed and nothing booked.
      expect(await list(tutor)).toEqual([]);

      // Written up the way the app writes one up, rather than by editing the
      // balance directly — the whole point is that this list follows from the
      // register and needs nothing else kept in step.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      const [row] = await list(tutor);
      expect(row).toMatchObject({ lessonsOwed: 1, paidLessonsLeft: -1 });
    });

    it('goes away again when the lesson is excused', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, {
        school,
        tutor,
        paidLessonsLeft: 0,
      });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: at(-1),
        status: LessonStatus.SCHEDULED,
      });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);
      expect(await list(tutor)).toHaveLength(1);

      // Cancelled in time after all: the lesson goes back on the package, so the
      // debt goes with it.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      expect(await list(tutor)).toEqual([]);
    });
  });
});
