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

/** A fixed past instant: a lesson being written up has already happened. */
const YESTERDAY = new Date('2026-08-23T09:00:00.000Z');

describe('Gradebook', () => {
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

  /** The common shape: a school, its tutor, their student, one past lesson. */
  async function seed(options: { gradeScaleMax?: number } = {}) {
    const school = await makeSchool(test, options);
    const tutor = await makeUser(test, { school, name: 'Anna' });
    const student = await makeStudent(test, {
      school,
      tutor,
      paidLessonsLeft: 4,
    });
    const lesson = await makeLesson(test, {
      school,
      tutor,
      student,
      startsAt: YESTERDAY,
    });

    return { school, tutor, student, lesson };
  }

  /** One student's line in a lesson's register, from a response body. */
  type RegisterEntry = {
    studentId: string;
    status: string;
    homeworkDone: boolean | null;
  };

  /**
   * Takes `unknown` rather than a shape, because supertest types every body as
   * `any` — declaring the shape here would only move the unchecked cast to every
   * call site.
   */
  const register = (
    body: unknown,
    studentId: string,
  ): RegisterEntry | undefined =>
    (body as { attendances?: RegisterEntry[] }).attendances?.find(
      (entry) => entry.studentId === studentId,
    );

  const paidLessonsLeft = async (studentId: string) =>
    (
      await test.prisma.student.findUniqueOrThrow({
        where: { id: studentId },
        select: { paidLessonsLeft: true },
      })
    ).paidLessonsLeft;

  describe('writing up a lesson', () => {
    it('saves topic, homework and attendance in one request', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          topic: '  Past simple, questions  ',
          homework: 'Workbook p. 34',
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      expect(response.body).toMatchObject({
        topic: 'Past simple, questions',
        homework: 'Workbook p. 34',
        status: LessonStatus.COMPLETED,
      });
      expect(register(response.body, student.id)).toMatchObject({
        status: AttendanceStatus.PRESENT,
      });
    });

    it('leaves out what the payload leaves out', async () => {
      const { tutor, student, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({ topic: 'Reported speech' })
        .expect(200);

      // Attendance later, from a different screen — the topic must survive it.
      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.LATE },
          ],
        })
        .expect(200);

      expect(response.body).toMatchObject({ topic: 'Reported speech' });
      expect(register(response.body, student.id)).toMatchObject({
        status: AttendanceStatus.LATE,
      });
    });

    it('clears a field written by mistake', async () => {
      const { tutor, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({ homework: 'Wrong page' })
        .expect(200);

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({ homework: '   ' })
        .expect(200);

      // Null, not an empty string: "cleared" and "never written" must render
      // the same, or the app grows a branch for the difference.
      expect(response.body.homework).toBeNull();
    });

    it('charges for a lesson the student attended', async () => {
      const { tutor, student, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      expect(await paidLessonsLeft(student.id)).toBe(3);
    });

    it('charges for a no-show, because the slot was held', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.ABSENT_UNEXCUSED,
            },
          ],
        })
        .expect(200);

      expect(response.body.status).toBe(LessonStatus.COMPLETED);
      expect(await paidLessonsLeft(student.id)).toBe(3);
    });

    it('gives the slot back for an excused absence', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      expect(response.body.status).toBe(LessonStatus.CANCELLED);
      expect(await paidLessonsLeft(student.id)).toBe(4);
    });

    it('does not charge twice when the write-up is corrected', async () => {
      const { tutor, student, lesson } = await seed();
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

      // Same lesson, corrected to "was late". Still one lesson spent, not two.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.LATE },
          ],
        })
        .expect(200);

      expect(await paidLessonsLeft(student.id)).toBe(3);
    });

    it('lets an explicit status override what attendance implies', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.ABSENT_UNEXCUSED,
            },
          ],
          status: LessonStatus.CANCELLED,
        })
        .expect(200);

      expect(response.body.status).toBe(LessonStatus.CANCELLED);
      expect(register(response.body, student.id)).toMatchObject({
        status: AttendanceStatus.ABSENT_UNEXCUSED,
      });
      // Explicit status moves the schedule; the register still charges, because
      // the register is what says the student used the slot.
      expect(await paidLessonsLeft(student.id)).toBe(3);
    });

    it('rejects an attendance value that is not one of the four', async () => {
      const { tutor, student, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({ attendance: [{ studentId: student.id, status: 'MAYBE' }] })
        .expect(400);
    });

    it('needs a token', async () => {
      const { lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .send({ topic: 'Anything' })
        .expect(401);
    });
  });

  describe('who may write up a lesson', () => {
    it("hides a colleague's lesson behind a 404", async () => {
      const { school, lesson } = await seed();
      const colleague = await makeUser(test, { school });

      // Not 403: that would confirm the id exists.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, colleague))
        .send({ topic: 'Not mine' })
        .expect(404);
    });

    it('lets an admin write up any lesson in their school', async () => {
      const { school, lesson } = await seed();
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, admin))
        .send({ topic: 'Covering for Anna' })
        .expect(200);
    });

    it("hides another school's lesson entirely", async () => {
      const { lesson } = await seed();
      const other = await makeSchool(test);
      const outsider = await makeUser(test, {
        school: other,
        role: UserRole.ADMIN,
      });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, outsider))
        .send({ topic: 'Not your school' })
        .expect(404);
    });
  });

  describe('marks', () => {
    it('records a mark against a lesson, and derives the student from it', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .post(`/api/lessons/${lesson.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({
          kind: GradeKind.CLASSIC,
          value: 11,
          category: 'Speaking',
          weight: 2,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        kind: GradeKind.CLASSIC,
        value: 11,
        category: 'Speaking',
        weight: 2,
        studentId: student.id,
        lessonId: lesson.id,
        author: { id: tutor.id, name: 'Anna' },
      });
    });

    it('records a mark that belongs to no lesson', async () => {
      const { tutor, student } = await seed();

      const response = await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({
          kind: GradeKind.PERCENTAGE,
          value: 87.5,
          category: 'Term test',
        })
        .expect(201);

      expect(response.body).toMatchObject({ value: 87.5, lessonId: null });
    });

    it('needs no capability, because marking work is part of teaching', async () => {
      const { tutor, lesson } = await seed();

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 8 })
        .expect(201);
    });
  });

  describe('validating a mark', () => {
    it('stores a descriptive mark with no number at all', async () => {
      const { tutor, student } = await seed();

      const response = await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({
          kind: GradeKind.DESCRIPTIVE,
          comment: 'Confident, still rushing the endings.',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        value: null,
        comment: 'Confident, still rushing the endings.',
      });
    });

    it('rejects a descriptive mark with no words', async () => {
      const { tutor, student } = await seed();

      // A descriptive grade without the description is not a grade.
      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.DESCRIPTIVE })
        .expect(400);
    });

    it('rejects a numeric mark with no number', async () => {
      const { tutor, student } = await seed();

      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, comment: 'Good' })
        .expect(400);
    });

    it("rejects a mark above the school's own scale", async () => {
      // A school grading out of 6 must not accept a 12 typed out of habit.
      const { tutor, student } = await seed({ gradeScaleMax: 6 });

      const response = await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 12 })
        .expect(400);

      expect(response.body.message).toContain('6');
    });

    it("accepts the top of the school's scale", async () => {
      const { tutor, student } = await seed({ gradeScaleMax: 6 });

      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 6 })
        .expect(201);
    });

    it("rejects a percentage over 100 whatever the school's scale", async () => {
      const { tutor, student } = await seed({ gradeScaleMax: 12 });

      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.PERCENTAGE, value: 120 })
        .expect(400);
    });

    it('rejects a negative mark', async () => {
      const { tutor, student } = await seed();

      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: -1 })
        .expect(400);
    });

    it('rejects an absurd weight', async () => {
      const { tutor, student } = await seed();

      await request(test.server)
        .post(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 8, weight: 100 })
        .expect(400);
    });
  });

  describe('reading marks', () => {
    it("lists a student's marks newest first, lesson-bound ones included", async () => {
      const { tutor, student, lesson } = await seed();

      await makeGrade(test, { student, author: tutor, value: 7 });
      await makeGrade(test, { student, author: tutor, lesson, value: 9 });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((g: { value: number }) => g.value)).toEqual([
        9, 7,
      ]);
    });

    it("lists only one lesson's marks under that lesson", async () => {
      const { tutor, student, lesson } = await seed();

      await makeGrade(test, { student, author: tutor, value: 7 });
      await makeGrade(test, { student, author: tutor, lesson, value: 9 });

      const response = await request(test.server)
        .get(`/api/lessons/${lesson.id}/grades`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].value).toBe(9);
    });

    it("hides another school's marks", async () => {
      const { student } = await seed();
      const other = await makeSchool(test);
      const outsider = await makeUser(test, {
        school: other,
        role: UserRole.ADMIN,
      });

      await request(test.server)
        .get(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, outsider))
        .expect(404);
    });

    it('survives the lesson it was given in being deleted', async () => {
      const { tutor, student, lesson } = await seed();
      await makeGrade(test, { student, author: tutor, lesson, value: 9 });

      // Deleting a lesson must not delete a student's record of their work.
      await test.prisma.lesson.delete({ where: { id: lesson.id } });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/grades`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].lessonId).toBeNull();
    });
  });

  describe('correcting a mark', () => {
    it('replaces it whole, clearing what the new kind cannot carry', async () => {
      const { tutor, student } = await seed();
      const grade = await makeGrade(test, {
        student,
        author: tutor,
        value: 9,
        category: 'Speaking',
      });

      const response = await request(test.server)
        .put(`/api/grades/${grade.id}`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.DESCRIPTIVE, comment: 'Rethought this one.' })
        .expect(200);

      // The old number must not survive under the new kind.
      expect(response.body).toMatchObject({
        kind: GradeKind.DESCRIPTIVE,
        value: null,
        category: null,
        comment: 'Rethought this one.',
      });
    });

    it('lets only the author change it', async () => {
      const { school, tutor, student } = await seed();
      const colleague = await makeUser(test, { school, role: UserRole.ADMIN });
      const grade = await makeGrade(test, { student, author: colleague });

      // Reachable through the student, but not theirs to rewrite.
      await request(test.server)
        .put(`/api/grades/${grade.id}`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 12 })
        .expect(403);
    });

    it('lets an admin overrule', async () => {
      const { school, tutor, student } = await seed();
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const grade = await makeGrade(test, { student, author: tutor, value: 4 });

      await request(test.server)
        .put(`/api/grades/${grade.id}`)
        .set(await authHeader(test, admin))
        .send({ kind: GradeKind.CLASSIC, value: 8 })
        .expect(200);
    });
  });

  describe('removing a mark', () => {
    it('lets the author remove their own', async () => {
      const { tutor, student } = await seed();
      const grade = await makeGrade(test, { student, author: tutor });

      await request(test.server)
        .delete(`/api/grades/${grade.id}`)
        .set(await authHeader(test, tutor))
        .expect(204);

      expect(
        await test.prisma.grade.findUnique({ where: { id: grade.id } }),
      ).toBeNull();
    });

    it("refuses a colleague's", async () => {
      const { school, tutor, student } = await seed();
      const colleague = await makeUser(test, { school, role: UserRole.ADMIN });
      const grade = await makeGrade(test, { student, author: colleague });

      await request(test.server)
        .delete(`/api/grades/${grade.id}`)
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('404s on one that never existed', async () => {
      const { tutor } = await seed();

      await request(test.server)
        .delete('/api/grades/does-not-exist')
        .set(await authHeader(test, tutor))
        .expect(404);
    });
  });

  describe('progress', () => {
    it('averages each kind separately and rates attendance', async () => {
      const { school, tutor, student } = await seed();

      await makeGrade(test, { student, author: tutor, value: 10, weight: 3 });
      await makeGrade(test, { student, author: tutor, value: 6, weight: 1 });
      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.PERCENTAGE,
        value: 80,
      });
      await makeGrade(test, {
        student,
        author: tutor,
        kind: GradeKind.DESCRIPTIVE,
        comment: 'Reads well.',
      });

      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date('2026-08-01T09:00:00.000Z'),
        attendance: AttendanceStatus.PRESENT,
      });
      await makeMarkedLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date('2026-08-08T09:00:00.000Z'),
        attendance: AttendanceStatus.ABSENT_UNEXCUSED,
      });

      const response = await request(test.server)
        .get(`/api/students/${student.id}/progress`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.grades).toEqual({
        count: 4,
        // (10x3 + 6) / 4 = 9 — the weight is what makes this not 8.
        classic: { average: 9, count: 2 },
        percentage: { average: 80, count: 1 },
        descriptiveCount: 1,
      });
      // The unmarked lesson from `seed` is not in the denominator.
      expect(response.body.attendance).toMatchObject({ marked: 2, rate: 0.5 });
      expect(response.body.lessons).toMatchObject({ total: 3, completed: 2 });
    });

    it('reports no rate rather than zero for a new student', async () => {
      const { tutor, student } = await seed();

      const response = await request(test.server)
        .get(`/api/students/${student.id}/progress`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.attendance.rate).toBeNull();
      expect(response.body.grades.classic).toBeNull();
    });

    it('reflects a write-up immediately, with no cache to go stale', async () => {
      const { tutor, student, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      const response = await request(test.server)
        .get(`/api/students/${student.id}/progress`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.attendance).toMatchObject({
        present: 1,
        marked: 1,
        rate: 1,
      });
    });

    it("refuses another tutor's student", async () => {
      const { school, student } = await seed();
      const colleague = await makeUser(test, { school });

      await request(test.server)
        .get(`/api/students/${student.id}/progress`)
        .set(await authHeader(test, colleague))
        .expect(403);
    });
  });

  describe('whether the homework came back', () => {
    it('starts as unknown rather than as "not done"', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          homework: 'Exercises 1-5',
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      // Null, not false: nobody has checked yet, and reporting that as work not
      // done would accuse every student of every unchecked lesson.
      expect(register(response.body, student.id)?.homeworkDone).toBeNull();
    });

    it('records it done without touching what was set', async () => {
      const { tutor, student, lesson } = await seed();
      const header = await authHeader(test, tutor);

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          homework: 'Exercises 1-5',
          attendance: [
            { studentId: student.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);

      // Checked at the *start of the next lesson*, which is why it arrives in
      // its own request a week after the text did.
      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.PRESENT,
              homeworkDone: true,
            },
          ],
        })
        .expect(200);

      expect(response.body.homework).toBe('Exercises 1-5');
      expect(register(response.body, student.id)?.homeworkDone).toBe(true);
    });

    it('records it not done', async () => {
      const { tutor, student, lesson } = await seed();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.PRESENT,
              homeworkDone: false,
            },
          ],
        })
        .expect(200);

      expect(register(response.body, student.id)?.homeworkDone).toBe(false);
    });

    it('survives a later write-up that does not mention it', async () => {
      const { tutor, student, lesson } = await seed();
      const header = await authHeader(test, tutor);

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.PRESENT,
              homeworkDone: false,
            },
          ],
        })
        .expect(200);

      // Correcting attendance must not wipe a homework check made separately.
      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          topic: 'Went back over it',
          attendance: [
            { studentId: student.id, status: AttendanceStatus.LATE },
          ],
        })
        .expect(200);

      expect(register(response.body, student.id)).toMatchObject({
        status: AttendanceStatus.LATE,
        homeworkDone: false,
      });
    });

    it('rejects a value that is not a boolean', async () => {
      const { tutor, student, lesson } = await seed();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            {
              studentId: student.id,
              status: AttendanceStatus.PRESENT,
              homeworkDone: 'maybe',
            },
          ],
        })
        .expect(400);
    });
  });

  describe('a group lesson', () => {
    /** Three students in one group, with one lesson booked for it. */
    async function seedGroup() {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school, name: 'Anna' });
      const [ann, bob, cat] = await Promise.all([
        makeStudent(test, { school, tutor, name: 'Ann', paidLessonsLeft: 4 }),
        makeStudent(test, { school, tutor, name: 'Bob', paidLessonsLeft: 4 }),
        makeStudent(test, { school, tutor, name: 'Cat', paidLessonsLeft: 4 }),
      ]);
      const group = await makeGroup(test, {
        school,
        tutor,
        name: 'B1 Tuesdays',
        members: [ann, bob, cat],
      });
      const lesson = await makeGroupLesson(test, {
        school,
        tutor,
        group,
        startsAt: YESTERDAY,
      });

      return { school, tutor, ann, bob, cat, group, lesson };
    }

    it('marks the whole room in one request', async () => {
      const { tutor, ann, bob, cat, lesson } = await seedGroup();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          topic: 'Present perfect',
          homework: 'Unit 5',
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.PRESENT },
            { studentId: bob.id, status: AttendanceStatus.LATE },
            { studentId: cat.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      expect(response.body.attendances).toHaveLength(3);
      expect(register(response.body, cat.id)).toMatchObject({
        status: AttendanceStatus.ABSENT_EXCUSED,
      });
    });

    it('charges only the students who used the slot', async () => {
      const { tutor, ann, bob, cat, lesson } = await seedGroup();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.PRESENT },
            { studentId: bob.id, status: AttendanceStatus.ABSENT_UNEXCUSED },
            { studentId: cat.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      // Present: charged. No-show: charged, the seat was held. Excused: not.
      expect(await paidLessonsLeft(ann.id)).toBe(3);
      expect(await paidLessonsLeft(bob.id)).toBe(3);
      expect(await paidLessonsLeft(cat.id)).toBe(4);
    });

    it('counts as taught when anybody came', async () => {
      const { tutor, ann, bob, cat, lesson } = await seedGroup();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.PRESENT },
            { studentId: bob.id, status: AttendanceStatus.ABSENT_EXCUSED },
            { studentId: cat.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      expect(response.body.status).toBe(LessonStatus.COMPLETED);
    });

    it('counts as cancelled when the whole room was excused', async () => {
      const { tutor, ann, bob, cat, lesson } = await seedGroup();

      const response = await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.ABSENT_EXCUSED },
            { studentId: bob.id, status: AttendanceStatus.ABSENT_EXCUSED },
            { studentId: cat.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);

      expect(response.body.status).toBe(LessonStatus.CANCELLED);
    });

    it('refunds a student whose absence is corrected to excused', async () => {
      const { tutor, ann, lesson } = await seedGroup();
      const header = await authHeader(test, tutor);

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.ABSENT_UNEXCUSED },
          ],
        })
        .expect(200);
      expect(await paidLessonsLeft(ann.id)).toBe(3);

      // A correction has to refund, or the student pays for the tutor's typo.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(header)
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.ABSENT_EXCUSED },
          ],
        })
        .expect(200);
      expect(await paidLessonsLeft(ann.id)).toBe(4);
    });

    it('refuses a student who is not in the group', async () => {
      const { school, tutor, lesson } = await seedGroup();
      const outsider = await makeStudent(test, { school, tutor, name: 'Dan' });

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: outsider.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(400);
    });

    it('refuses two entries for the same student', async () => {
      const { tutor, ann, lesson } = await seedGroup();

      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: ann.id, status: AttendanceStatus.PRESENT },
            { studentId: ann.id, status: AttendanceStatus.LATE },
          ],
        })
        .expect(400);
    });

    it('covers whoever is in the group now, not when it was booked', async () => {
      const { school, tutor, group, lesson } = await seedGroup();
      const late = await makeStudent(test, { school, tutor, name: 'Eve' });
      await test.prisma.groupMember.create({
        data: { groupId: group.id, studentId: late.id },
      });

      // Joining a group on Tuesday puts you in Wednesday's lesson without
      // anybody editing the lesson.
      await request(test.server)
        .patch(`/api/lessons/${lesson.id}/journal`)
        .set(await authHeader(test, tutor))
        .send({
          attendance: [
            { studentId: late.id, status: AttendanceStatus.PRESENT },
          ],
        })
        .expect(200);
    });

    it('names the student when marking work in a group', async () => {
      const { tutor, ann, lesson } = await seedGroup();

      const response = await request(test.server)
        .post(`/api/lessons/${lesson.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ studentId: ann.id, kind: GradeKind.CLASSIC, value: 10 })
        .expect(201);

      expect(response.body).toMatchObject({
        studentId: ann.id,
        lessonId: lesson.id,
      });
    });

    it('refuses a mark on a group lesson that names nobody', async () => {
      const { tutor, lesson } = await seedGroup();

      // The lesson cannot say who the mark is for, so guessing would be wrong.
      await request(test.server)
        .post(`/api/lessons/${lesson.id}/grades`)
        .set(await authHeader(test, tutor))
        .send({ kind: GradeKind.CLASSIC, value: 10 })
        .expect(400);
    });
  });
});
