import request from 'supertest';

import { LessonStatus, UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeGroup,
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

describe('Subjects', () => {
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

  async function seed() {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school, name: 'Anna' });

    return { school, admin, tutor };
  }

  describe('reading the list', () => {
    it('gives every member the subjects on offer, in name order', async () => {
      const { school, tutor } = await seed();
      await makeSubject(test, { school, name: 'Physics' });
      await makeSubject(test, { school, name: 'Algebra' });

      // A tutor with no capabilities at all: every booking form needs this list,
      // so reading it cannot be a privilege.
      const response = await request(test.server)
        .get('/api/subjects')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(
        response.body.map((subject: { name: string }) => subject.name),
      ).toEqual(['Algebra', 'Physics']);
    });

    it('leaves out what has been hidden, unless asked', async () => {
      const { school, admin } = await seed();
      await makeSubject(test, { school, name: 'Algebra' });
      await makeSubject(test, { school, name: 'Latin', hiddenAt: new Date() });

      const header = await authHeader(test, admin);

      const offered = await request(test.server)
        .get('/api/subjects')
        .set(header)
        .expect(200);
      expect(
        offered.body.map((subject: { name: string }) => subject.name),
      ).toEqual(['Algebra']);

      const all = await request(test.server)
        .get('/api/subjects?includeHidden=true')
        .set(header)
        .expect(200);
      expect(all.body.map((subject: { name: string }) => subject.name)).toEqual(
        ['Algebra', 'Latin'],
      );
    });

    it("never shows another school's list", async () => {
      const { school, tutor } = await seed();
      const other = await makeSchool(test);
      await makeSubject(test, { school, name: 'Ours' });
      await makeSubject(test, { school: other, name: 'Theirs' });

      const response = await request(test.server)
        .get('/api/subjects')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(
        response.body.map((subject: { name: string }) => subject.name),
      ).toEqual(['Ours']);
    });
  });

  describe('adding one', () => {
    it('is for admins, and trims what was typed', async () => {
      const { school, admin } = await seed();

      const response = await request(test.server)
        .post('/api/subjects')
        .set(await authHeader(test, admin))
        .send({ name: '  Chemistry  ' })
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'Chemistry',
        schoolId: school.id,
        hiddenAt: null,
      });
    });

    it('is refused to a tutor', async () => {
      const { tutor } = await seed();

      await request(test.server)
        .post('/api/subjects')
        .set(await authHeader(test, tutor))
        .send({ name: 'Chemistry' })
        .expect(403);
    });

    it('refuses a name the school already has, whatever the case', async () => {
      const { school, admin } = await seed();
      await makeSubject(test, { school, name: 'Algebra' });

      const response = await request(test.server)
        .post('/api/subjects')
        .set(await authHeader(test, admin))
        .send({ name: 'algebra' })
        .expect(409);

      expect(response.body.code).toBe('SUBJECT_EXISTS');
    });

    it('offers the hidden row back rather than reporting a name it cannot see', async () => {
      const { school, admin } = await seed();
      const latin = await makeSubject(test, {
        school,
        name: 'Latin',
        hiddenAt: new Date(),
      });

      const response = await request(test.server)
        .post('/api/subjects')
        .set(await authHeader(test, admin))
        .send({ name: 'Latin' })
        .expect(409);

      // The distinction the app needs: "taken" is unhelpful when the row holding
      // the name is one the admin cannot see. This says which row it is.
      expect(response.body.code).toBe('SUBJECT_HIDDEN');
      expect(response.body.subject.id).toBe(latin.id);
    });
  });

  describe('what still uses it', () => {
    it('names what is current and counts the lessons on either side of now', async () => {
      const { school, admin, tutor } = await seed();
      const algebra = await makeSubject(test, { school, name: 'Algebra' });
      const student = await makeStudent(test, {
        school,
        tutor,
        name: 'Petro',
        subject: 'Algebra',
      });
      await makeGroup(test, {
        school,
        tutor,
        name: 'Algebra Tuesdays',
        subject: 'Algebra',
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        subject: 'Algebra',
        startsAt: at(1),
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        subject: 'Algebra',
        startsAt: at(-7),
        status: LessonStatus.COMPLETED,
      });

      const response = await request(test.server)
        .get(`/api/subjects/${algebra.id}/usage`)
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toMatchObject({
        students: [{ id: student.id, name: 'Petro' }],
        groups: [{ name: 'Algebra Tuesdays' }],
        upcomingLessons: 1,
        pastLessons: 1,
        canHide: false,
      });
    });

    it('treats a cancelled lesson in the future as history', async () => {
      const { school, admin, tutor } = await seed();
      const algebra = await makeSubject(test, { school, name: 'Algebra' });
      // Nobody studies it and nobody is going to teach it: a cancelled lesson
      // must not keep a subject on the list forever.
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, {
        school,
        tutor,
        student,
        subject: 'Algebra',
        startsAt: at(3),
        status: LessonStatus.CANCELLED,
      });

      const response = await request(test.server)
        .get(`/api/subjects/${algebra.id}/usage`)
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toMatchObject({
        upcomingLessons: 0,
        pastLessons: 1,
        canHide: true,
      });
    });
  });

  describe('taking one off the list', () => {
    it('is refused while a student still studies it, and says which', async () => {
      const { school, admin, tutor } = await seed();
      const algebra = await makeSubject(test, { school, name: 'Algebra' });
      const student = await makeStudent(test, {
        school,
        tutor,
        name: 'Petro',
        subject: 'Algebra',
      });

      const response = await request(test.server)
        .post(`/api/subjects/${algebra.id}/hide`)
        .set(await authHeader(test, admin))
        .expect(409);

      // The refusal carries the whole report, so the app can name who has to be
      // moved instead of showing a count and leaving the admin to search.
      expect(response.body.code).toBe('SUBJECT_IN_USE');
      expect(response.body.usage.students).toEqual([
        { id: student.id, name: 'Petro' },
      ]);
    });

    it('goes through once nothing current points at it', async () => {
      const { school, admin, tutor } = await seed();
      const algebra = await makeSubject(test, { school, name: 'Algebra' });
      const physics = await makeSubject(test, { school, name: 'Physics' });
      const student = await makeStudent(test, {
        school,
        tutor,
        subject: 'Algebra',
      });
      const header = await authHeader(test, admin);

      await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(header)
        .send({ subjectId: physics.id })
        .expect(200);

      await request(test.server)
        .post(`/api/subjects/${algebra.id}/hide`)
        .set(header)
        .expect(201);

      const offered = await request(test.server)
        .get('/api/subjects')
        .set(header)
        .expect(200);
      expect(
        offered.body.map((subject: { name: string }) => subject.name),
      ).toEqual(['Physics']);
    });

    it('leaves a lesson already taught reading exactly as it did', async () => {
      const { school, admin, tutor } = await seed();
      const algebra = await makeSubject(test, { school, name: 'Algebra' });
      const physics = await makeSubject(test, { school, name: 'Physics' });
      const student = await makeStudent(test, {
        school,
        tutor,
        subject: 'Algebra',
      });
      await makeLesson(test, {
        school,
        tutor,
        student,
        subject: 'Algebra',
        startsAt: at(-7),
        status: LessonStatus.COMPLETED,
        topic: 'Quadratics',
      });
      const header = await authHeader(test, admin);

      await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(header)
        .send({ subjectId: physics.id })
        .expect(200);
      await request(test.server)
        .post(`/api/subjects/${algebra.id}/hide`)
        .set(header)
        .expect(201);

      // This is the reason hiding exists rather than deleting. The lesson was
      // taught in Algebra and still says so, months after the school stopped
      // offering it.
      const history = await request(test.server)
        .get(`/api/students/${student.id}/lessons`)
        .set(header)
        .expect(200);

      expect(history.body).toHaveLength(1);
      expect(history.body[0].subject).toMatchObject({
        id: algebra.id,
        name: 'Algebra',
      });
      expect(history.body[0].topic).toBe('Quadratics');
    });

    it('is not an error the second time', async () => {
      const { school, admin } = await seed();
      const latin = await makeSubject(test, { school, name: 'Latin' });
      const header = await authHeader(test, admin);

      await request(test.server)
        .post(`/api/subjects/${latin.id}/hide`)
        .set(header)
        .expect(201);
      // The second admin to press it wanted the outcome they already have.
      const again = await request(test.server)
        .post(`/api/subjects/${latin.id}/hide`)
        .set(header)
        .expect(201);

      expect(again.body.hiddenAt).not.toBeNull();
    });

    it('is refused to a tutor', async () => {
      const { school, tutor } = await seed();
      const latin = await makeSubject(test, { school, name: 'Latin' });

      await request(test.server)
        .post(`/api/subjects/${latin.id}/hide`)
        .set(await authHeader(test, tutor))
        .expect(403);
    });
  });

  describe('a subject nobody can book any more', () => {
    it('cannot be given to somebody new', async () => {
      const { school, admin } = await seed();
      const latin = await makeSubject(test, {
        school,
        name: 'Latin',
        hiddenAt: new Date(),
      });

      await request(test.server)
        .post('/api/students')
        .set(await authHeader(test, admin))
        .send({ name: 'Newcomer', subjectId: latin.id })
        .expect(400);
    });

    it('does not block an edit to the student who already studies it', async () => {
      const { school, admin, tutor } = await seed();
      const latin = await makeSubject(test, { school, name: 'Latin' });
      const student = await makeStudent(test, {
        school,
        tutor,
        name: 'Petro',
        subject: 'Latin',
      });
      const header = await authHeader(test, admin);

      await request(test.server)
        .post(`/api/subjects/${latin.id}/hide`)
        .set(header)
        .expect(409);

      // Hidden by hand, since the endpoint rightly refuses while he studies it.
      await test.prisma.subject.update({
        where: { id: latin.id },
        data: { hiddenAt: new Date() },
      });

      // Correcting his name must not require reassigning him first. The app
      // sends the whole form back, subject included, and a plain "no hidden
      // subjects" rule would refuse a field the editor never touched.
      const response = await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(header)
        .send({ name: 'Petro Melnyk', subjectId: latin.id })
        .expect(200);

      expect(response.body).toMatchObject({
        name: 'Petro Melnyk',
        subject: { id: latin.id, name: 'Latin' },
      });
    });

    it('comes back on the list when restored', async () => {
      const { school, admin } = await seed();
      const latin = await makeSubject(test, {
        school,
        name: 'Latin',
        hiddenAt: new Date(),
      });
      const header = await authHeader(test, admin);

      const restored = await request(test.server)
        .post(`/api/subjects/${latin.id}/restore`)
        .set(header)
        .expect(201);
      expect(restored.body.hiddenAt).toBeNull();

      const offered = await request(test.server)
        .get('/api/subjects')
        .set(header)
        .expect(200);
      expect(
        offered.body.map((subject: { name: string }) => subject.name),
      ).toEqual(['Latin']);
    });
  });

  describe('renaming', () => {
    it('corrects it everywhere at once', async () => {
      const { school, admin, tutor } = await seed();
      const misspelled = await makeSubject(test, {
        school,
        name: 'Mathmatics',
      });
      const student = await makeStudent(test, {
        school,
        tutor,
        subject: 'Mathmatics',
      });
      const header = await authHeader(test, admin);

      await request(test.server)
        .patch(`/api/subjects/${misspelled.id}`)
        .set(header)
        .send({ name: 'Mathematics' })
        .expect(200);

      // The point of a row rather than a word: nobody had to find the student.
      const response = await request(test.server)
        .get(`/api/students/${student.id}`)
        .set(header)
        .expect(200);
      expect(response.body.subject.name).toBe('Mathematics');
    });

    it('refuses a name the school already has', async () => {
      const { school, admin } = await seed();
      await makeSubject(test, { school, name: 'Physics' });
      const algebra = await makeSubject(test, { school, name: 'Algebra' });

      const response = await request(test.server)
        .patch(`/api/subjects/${algebra.id}`)
        .set(await authHeader(test, admin))
        .send({ name: 'Physics' })
        .expect(409);

      expect(response.body.code).toBe('SUBJECT_EXISTS');
    });
  });

  describe('one school cannot touch another', () => {
    it("reports a neighbour's subject as not found", async () => {
      const { admin } = await seed();
      const other = await makeSchool(test);
      const theirs = await makeSubject(test, { school: other, name: 'Theirs' });
      const header = await authHeader(test, admin);

      // Not-found rather than forbidden throughout: a 403 would confirm the id
      // exists.
      await request(test.server)
        .get(`/api/subjects/${theirs.id}/usage`)
        .set(header)
        .expect(404);
      await request(test.server)
        .post(`/api/subjects/${theirs.id}/hide`)
        .set(header)
        .expect(404);
      await request(test.server)
        .patch(`/api/subjects/${theirs.id}`)
        .set(header)
        .send({ name: 'Ours now' })
        .expect(404);
    });

    it("will not attach a student to a neighbour's subject", async () => {
      const { admin } = await seed();
      const other = await makeSchool(test);
      const theirs = await makeSubject(test, { school: other, name: 'Theirs' });

      // Otherwise a school could hang its records off a subject somebody else
      // owns, and have it renamed out from under them.
      await request(test.server)
        .post('/api/students')
        .set(await authHeader(test, admin))
        .send({ name: 'Borrowed', subjectId: theirs.id })
        .expect(404);
    });
  });
});
