import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeLesson,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Students', () => {
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

  describe('reading', () => {
    it('is open to a member with no capabilities, because the calendar needs names', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      await makeStudent(test, { school, tutor, name: 'Ivan' });

      const response = await request(test.server)
        .get('/api/students')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it('shows a tutor only their own students', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      await makeStudent(test, { school, tutor, name: 'Mine' });
      await makeStudent(test, { school, tutor: colleague, name: 'Theirs' });

      const response = await request(test.server)
        .get('/api/students')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((s: { name: string }) => s.name)).toEqual([
        'Mine',
      ]);
    });

    it('shows an admin the whole school but not another one', async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const stranger = await makeUser(test, { school: other });
      await makeStudent(test, { school, tutor, name: 'Ours' });
      await makeStudent(test, {
        school: other,
        tutor: stranger,
        name: 'Elsewhere',
      });

      const response = await request(test.server)
        .get('/api/students')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body.map((s: { name: string }) => s.name)).toEqual([
        'Ours',
      ]);
    });
  });

  describe('writing without the capability', () => {
    it('is refused', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post('/api/students')
        .set(header)
        .send({ name: 'New' })
        .expect(403);

      await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(header)
        .send({ name: 'Renamed' })
        .expect(403);

      await request(test.server)
        .delete(`/api/students/${student.id}`)
        .set(header)
        .expect(403);
    });
  });

  describe('writing with the capability', () => {
    it("creates the student on the caller's own roster", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });

      const physics = await makeSubject(test, { school, name: 'Physics' });

      const response = await request(test.server)
        .post('/api/students')
        .set(await authHeader(test, tutor))
        .send({ name: '  Maria  ', subjectId: physics.id, paidLessonsLeft: 8 })
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'Maria',
        // The subject comes back as the row, not the word: the app needs the id
        // to preselect it and the name to show it.
        subject: { id: physics.id, name: 'Physics' },
        paidLessonsLeft: 8,
        tutorId: tutor.id,
        schoolId: school.id,
      });
    });

    it('lets a tutor edit their own student', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });
      const student = await makeStudent(test, { school, tutor });

      const response = await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(await authHeader(test, tutor))
        .send({ paidLessonsLeft: 0 })
        .expect(200);

      expect(response.body.paidLessonsLeft).toBe(0);
    });

    it("does not let a tutor edit a colleague's student", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      // The capability says they may edit students; whose is a separate question
      // and the server is the one that answers it.
      await request(test.server)
        .patch(`/api/students/${theirs.id}`)
        .set(await authHeader(test, tutor))
        .send({ name: 'Reassigned' })
        .expect(403);
    });

    it('lets an admin edit anybody in their school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await request(test.server)
        .patch(`/api/students/${student.id}`)
        .set(await authHeader(test, admin))
        .send({ name: 'Corrected' })
        .expect(200);
    });

    it("hides another school's student behind a 404 rather than a 403", async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const stranger = await makeUser(test, { school: other });
      const elsewhere = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });

      // A 403 would confirm the id exists.
      await request(test.server)
        .patch(`/api/students/${elsewhere.id}`)
        .set(await authHeader(test, admin))
        .send({ name: 'Nope' })
        .expect(404);
    });

    it('removes a student together with their lessons', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });
      const student = await makeStudent(test, { school, tutor });
      await makeLesson(test, { school, tutor, student, startsAt: new Date() });

      await request(test.server)
        .delete(`/api/students/${student.id}`)
        .set(await authHeader(test, tutor))
        .expect(204);

      expect(await test.prisma.student.count()).toBe(0);
      // The schema cascades. Asserted rather than assumed, because the day this
      // becomes an archive flag instead, this test is what says so.
      expect(await test.prisma.lesson.count()).toBe(0);
    });
  });
});
