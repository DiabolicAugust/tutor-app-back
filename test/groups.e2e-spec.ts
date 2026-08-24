import request from 'supertest';

import { AddonKey, UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeGroup,
  makeSchool,
  makeStudent,
  makeSubject,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Groups', () => {
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

  /** A tutor who may manage students, which is what gates group writes. */
  async function seed() {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, {
      school,
      name: 'Anna',
      addons: [AddonKey.MANAGE_STUDENTS],
    });
    const student = await makeStudent(test, { school, tutor, name: 'Petro' });
    // A group is created against a subject id now, so the school has to have
    // one before anything can be booked into it.
    const english = await makeSubject(test, { school, name: 'English' });

    return { school, tutor, student, english };
  }

  describe('creating one', () => {
    it('starts empty, and trims what was typed', async () => {
      const { tutor, english } = await seed();

      const response = await request(test.server)
        .post('/api/groups')
        .set(await authHeader(test, tutor))
        .send({ name: '  B1 Tuesdays  ', subjectId: english.id, level: ' B1 ' })
        .expect(201);

      expect(response.body).toMatchObject({
        name: 'B1 Tuesdays',
        subject: { id: english.id, name: 'English' },
        level: 'B1',
        members: [],
      });
    });

    it('stores no level rather than an empty one', async () => {
      const { tutor, english } = await seed();

      const response = await request(test.server)
        .post('/api/groups')
        .set(await authHeader(test, tutor))
        .send({ name: 'Conversation', subjectId: english.id, level: '  ' })
        .expect(201);

      expect(response.body.level).toBeNull();
    });

    it('needs the capability to manage students', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      // A body the pipe would accept, so the refusal can only be about the
      // capability. Sent deliberately rather than relying on guards running
      // before validation.
      const english = await makeSubject(test, { school, name: 'English' });

      // Putting students into groups *is* managing students, so it is gated on
      // the same addon rather than one of its own.
      await request(test.server)
        .post('/api/groups')
        .set(await authHeader(test, tutor))
        .send({ name: 'Nope', subjectId: english.id })
        .expect(403);
    });

    it('rejects a group with no name', async () => {
      const { tutor, english } = await seed();

      await request(test.server)
        .post('/api/groups')
        .set(await authHeader(test, tutor))
        .send({ name: '', subjectId: english.id })
        .expect(400);
    });
  });

  describe('membership', () => {
    it('adds a student and returns the whole group', async () => {
      const { school, tutor, student } = await seed();
      const group = await makeGroup(test, { school, tutor });

      const response = await request(test.server)
        .post(`/api/groups/${group.id}/members`)
        .set(await authHeader(test, tutor))
        .send({ studentId: student.id })
        .expect(201);

      expect(response.body.members).toHaveLength(1);
      expect(response.body.members[0].student).toMatchObject({
        id: student.id,
        name: 'Petro',
      });
    });

    it('is idempotent, so a double tap is not an error', async () => {
      const { school, tutor, student } = await seed();
      const group = await makeGroup(test, { school, tutor });
      const header = await authHeader(test, tutor);

      for (let i = 0; i < 2; i++) {
        await request(test.server)
          .post(`/api/groups/${group.id}/members`)
          .set(header)
          .send({ studentId: student.id })
          .expect(201);
      }

      const response = await request(test.server)
        .get(`/api/groups/${group.id}`)
        .set(header)
        .expect(200);

      expect(response.body.members).toHaveLength(1);
    });

    it("refuses a colleague's student", async () => {
      const { school, tutor } = await seed();
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });
      const group = await makeGroup(test, { school, tutor });

      // Otherwise a tutor could pull somebody else's student into their own
      // group and thereby see a history that was never theirs.
      await request(test.server)
        .post(`/api/groups/${group.id}/members`)
        .set(await authHeader(test, tutor))
        .send({ studentId: theirs.id })
        .expect(403);
    });

    it('removes a student without touching the student', async () => {
      const { school, tutor, student } = await seed();
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [student],
      });

      const response = await request(test.server)
        .delete(`/api/groups/${group.id}/members/${student.id}`)
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.members).toHaveLength(0);
      expect(
        await test.prisma.student.findUnique({ where: { id: student.id } }),
      ).not.toBeNull();
    });
  });

  describe('who may see a group', () => {
    it("hides a colleague's behind a 404", async () => {
      const { school, tutor } = await seed();
      const colleague = await makeUser(test, {
        school,
        addons: [AddonKey.MANAGE_STUDENTS],
      });
      const group = await makeGroup(test, { school, tutor });

      // Not 403: that would confirm the id exists.
      await request(test.server)
        .get(`/api/groups/${group.id}`)
        .set(await authHeader(test, colleague))
        .expect(404);
    });

    it('lists only your own', async () => {
      const { school, tutor } = await seed();
      const colleague = await makeUser(test, { school });
      await makeGroup(test, { school, tutor, name: 'Mine' });
      await makeGroup(test, { school, tutor: colleague, name: 'Theirs' });

      const response = await request(test.server)
        .get('/api/groups')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body.map((g: { name: string }) => g.name)).toEqual([
        'Mine',
      ]);
    });

    it('shows an admin the whole school', async () => {
      const { school, tutor } = await seed();
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      await makeGroup(test, { school, tutor, name: 'Mine' });

      const response = await request(test.server)
        .get('/api/groups')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });

    it("hides another school's entirely", async () => {
      const { school, tutor } = await seed();
      const group = await makeGroup(test, { school, tutor });
      const other = await makeSchool(test);
      const outsider = await makeUser(test, {
        school: other,
        role: UserRole.ADMIN,
      });

      await request(test.server)
        .get(`/api/groups/${group.id}`)
        .set(await authHeader(test, outsider))
        .expect(404);
    });

    it('is readable without the capability, but not writable', async () => {
      const { school } = await seed();
      // No `MANAGE_STUDENTS`: the calendar renders a group lesson by its group's
      // name, so gating reads would break the calendar for everybody.
      const plain = await makeUser(test, { school });
      const group = await makeGroup(test, {
        school,
        tutor: plain,
        name: 'Theirs',
      });
      const header = await authHeader(test, plain);

      const response = await request(test.server)
        .get('/api/groups')
        .set(header)
        .expect(200);
      expect(response.body).toHaveLength(1);

      // Their own group, and still not theirs to change without the capability.
      await request(test.server)
        .patch(`/api/groups/${group.id}`)
        .set(header)
        .send({ name: 'Renamed' })
        .expect(403);
    });
  });

  describe('editing and removing', () => {
    it('changes only what the patch names', async () => {
      const { school, tutor } = await seed();
      const group = await makeGroup(test, {
        school,
        tutor,
        name: 'B1',
        subject: 'English',
        level: 'B1',
      });

      const response = await request(test.server)
        .patch(`/api/groups/${group.id}`)
        .set(await authHeader(test, tutor))
        .send({ name: 'B1 Thursdays' })
        .expect(200);

      expect(response.body).toMatchObject({
        name: 'B1 Thursdays',
        subject: { name: 'English' },
        level: 'B1',
      });
    });

    it('clears a level when explicitly emptied', async () => {
      const { school, tutor } = await seed();
      const group = await makeGroup(test, { school, tutor, level: 'B1' });

      const response = await request(test.server)
        .patch(`/api/groups/${group.id}`)
        .set(await authHeader(test, tutor))
        .send({ level: '' })
        .expect(200);

      expect(response.body.level).toBeNull();
    });

    it('leaves the students behind when the group is dissolved', async () => {
      const { school, tutor, student } = await seed();
      const group = await makeGroup(test, {
        school,
        tutor,
        members: [student],
      });

      await request(test.server)
        .delete(`/api/groups/${group.id}`)
        .set(await authHeader(test, tutor))
        .expect(204);

      // Dissolving a group is not the same as losing the people in it.
      expect(
        await test.prisma.student.findUnique({ where: { id: student.id } }),
      ).not.toBeNull();
      expect(
        await test.prisma.groupMember.count({ where: { groupId: group.id } }),
      ).toBe(0);
    });
  });
});
