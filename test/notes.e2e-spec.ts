import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeLesson,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Notes', () => {
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

  describe('on a student', () => {
    it('records who wrote it, and trims what they typed', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school, name: 'Anna' });
      const student = await makeStudent(test, { school, tutor });

      const response = await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: '  Prefers morning lessons.  ' })
        .expect(201);

      expect(response.body).toMatchObject({
        text: 'Prefers morning lessons.',
        studentId: student.id,
        lessonId: null,
        author: { id: tutor.id, name: 'Anna' },
      });
    });

    it('needs no capability, because writing one is part of teaching', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: 'Anything at all' })
        .expect(201);
    });

    it('lists newest first', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      const first = await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(header)
        .send({ text: 'Older' })
        .expect(201);
      await test.prisma.note.update({
        where: { id: first.body.id as string },
        data: { createdAt: new Date(Date.now() - 60_000) },
      });
      await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(header)
        .send({ text: 'Newer' })
        .expect(201);

      const response = await request(test.server)
        .get(`/api/students/${student.id}/notes`)
        .set(header)
        .expect(200);

      expect(response.body.map((n: { text: string }) => n.text)).toEqual([
        'Newer',
        'Older',
      ]);
    });

    it("cannot be written on a colleague's student", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      await request(test.server)
        .post(`/api/students/${theirs.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: 'Not mine to annotate' })
        .expect(403);
    });

    it("cannot be read on another school's student", async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const stranger = await makeUser(test, { school: other });
      const elsewhere = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });

      await request(test.server)
        .get(`/api/students/${elsewhere.id}/notes`)
        .set(await authHeader(test, admin))
        .expect(404);
    });

    it('is reachable by an admin for anybody in their school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, admin))
        .send({ text: 'Checked in with the parent' })
        .expect(201);
    });

    it('goes when the student does', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(header)
        .send({ text: 'Will not outlive them' })
        .expect(201);

      await request(test.server)
        .delete(`/api/students/${student.id}`)
        .set(header)
        .expect(204);

      expect(await test.prisma.note.count()).toBe(0);
    });

    it('rejects an empty note', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: '' })
        .expect(400);
    });
  });

  describe('on a lesson', () => {
    it('belongs to the lesson, not to the student', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date(),
      });

      const response = await request(test.server)
        .post(`/api/lessons/${lesson.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({
          text: 'Covered quadratic equations; struggled with factoring.',
        })
        .expect(201);

      // A lesson already knows whose it is, so the note does not repeat it.
      expect(response.body).toMatchObject({
        lessonId: lesson.id,
        studentId: null,
      });
    });

    it('does not appear among the student general notes', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date(),
      });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/notes`)
        .set(header)
        .send({ text: 'About this lesson' })
        .expect(201);

      // Two different things shown in two different places: a note about one
      // hour is not a note about the person.
      const studentNotes = await request(test.server)
        .get(`/api/students/${student.id}/notes`)
        .set(header)
        .expect(200);

      expect(studentNotes.body).toEqual([]);
    });

    it("cannot be written on a colleague's lesson", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });
      const lesson = await makeLesson(test, {
        school,
        tutor: colleague,
        student: theirs,
        startsAt: new Date(),
      });

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: 'Not my lesson' })
        .expect(404);
    });

    it('goes when the lesson does', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date(),
      });

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: 'Transient' })
        .expect(201);

      await test.prisma.lesson.delete({ where: { id: lesson.id } });

      expect(await test.prisma.note.count()).toBe(0);
    });
  });

  describe('removal', () => {
    it('is allowed for the author', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      const created = await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(header)
        .send({ text: 'Mine to remove' })
        .expect(201);

      await request(test.server)
        .delete(`/api/notes/${created.body.id as string}`)
        .set(header)
        .expect(204);

      expect(await test.prisma.note.count()).toBe(0);
    });

    it('is refused for somebody who did not write it', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const created = await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, admin))
        .send({ text: 'Written by the admin' })
        .expect(201);

      // Editing what a colleague wrote is a different feature with different
      // expectations, and allowing it silently is the wrong default.
      await request(test.server)
        .delete(`/api/notes/${created.body.id as string}`)
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('is allowed for an admin cleaning up after a tutor', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const created = await request(test.server)
        .post(`/api/students/${student.id}/notes`)
        .set(await authHeader(test, tutor))
        .send({ text: 'Written by the tutor' })
        .expect(201);

      await request(test.server)
        .delete(`/api/notes/${created.body.id as string}`)
        .set(await authHeader(test, admin))
        .expect(204);
    });
  });
});
