import request from 'supertest';

import { AddonKey, LessonStatus, UserRole } from '../generated/prisma/enums';
import {
  authHeader,
  makeGrade,
  makeGroup,
  makeGroupLesson,
  makeLesson,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

/**
 * What one tutor may do to another's work, inside the same school.
 *
 * The other specs each prove their own rule, and between them they cover a good
 * deal of this. What none of them can show is the **shape** of the policy: which
 * things are shared on purpose, which are private, and that an admin can reach
 * everything a tutor cannot. That is what this file is for — one school, two
 * tutors and an admin, and every owned thing tried from the wrong side.
 *
 * It is written to be read as a policy document, so it deliberately repeats a
 * few assertions that live elsewhere. A security matrix with holes in it because
 * "that one is tested over there" is a matrix nobody can check at a glance.
 *
 * Two conventions worth knowing before reading the expectations:
 *
 * - A **404** is used where saying "forbidden" would confirm the id exists —
 *   groups and lessons take this line.
 * - A **403** is used for a student, which does confirm the id exists. That is
 *   an inconsistency rather than a decision, as far as the code says; it is
 *   recorded here rather than quietly changed, because the app reads these codes.
 *
 * Files are the one owned thing not repeated here: `files.e2e-spec` already
 * covers a colleague's library file, a colleague's student's file and a
 * colleague's lesson's file, which is the whole of that surface.
 */
describe('Two tutors in one school', () => {
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

  const at = (dayOffset: number, hour = 10): Date => {
    const date = new Date();
    date.setHours(hour, 0, 0, 0);
    date.setDate(date.getDate() + dayOffset);
    return date;
  };

  /**
   * A window wide enough for everything seeded here.
   *
   * Passed explicitly because the calendar defaults to starting *today*, and the
   * lessons below are yesterday's — which is what a school looks at when it is
   * checking what happened rather than what is coming.
   */
  const thisFortnight = () => ({
    from: at(-7).toISOString(),
    to: at(7).toISOString(),
  });

  /**
   * One school with everything in it owned by somebody.
   *
   * Both tutors hold `MANAGE_STUDENTS`, so every refusal below is about
   * *ownership* rather than about a missing capability — otherwise these tests
   * would pass on a server that had simply forgotten to grant anybody anything.
   */
  const aSchool = async () => {
    const school = await makeSchool(test, { name: 'Fox Academy' });

    const admin = await makeUser(test, {
      school,
      role: UserRole.ADMIN,
      name: 'Olha',
    });
    const anna = await makeUser(test, {
      school,
      name: 'Anna',
      addons: [AddonKey.MANAGE_STUDENTS],
    });
    const borys = await makeUser(test, {
      school,
      name: 'Borys',
      addons: [AddonKey.MANAGE_STUDENTS],
    });

    const annasStudent = await makeStudent(test, {
      school,
      tutor: anna,
      name: 'Ada',
    });
    const borysStudent = await makeStudent(test, {
      school,
      tutor: borys,
      name: 'Bohdan',
    });

    const borysGroup = await makeGroup(test, {
      school,
      tutor: borys,
      name: 'Bohdan and friends',
      members: [borysStudent],
    });

    const borysLesson = await makeLesson(test, {
      school,
      tutor: borys,
      student: borysStudent,
      startsAt: at(-1),
    });

    return {
      school,
      admin,
      anna,
      borys,
      annasStudent,
      borysStudent,
      borysGroup,
      borysLesson,
    };
  };

  /**
   * What the school shares on purpose.
   *
   * These are the first tests rather than an afterthought. A file full of
   * refusals invites somebody to "tighten" one of these into a refusal too, and
   * the school would stop working — a tutor who cannot see the roster cannot see
   * whose calendar to look at, and one who cannot see the subject list cannot
   * book a lesson.
   */
  describe('what colleagues share', () => {
    it('lets a tutor see who else teaches here', async () => {
      const { anna, borys } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/schools/current/tutors')
        .set(await authHeader(test, anna))
        .expect(200);

      expect((body as { id: string }[]).map((member) => member.id)).toContain(
        borys.id,
      );
    });

    it('shows a colleague their calendar when asked for it by name', async () => {
      const { anna, borys, borysLesson } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/lessons')
        .query({ ...thisFortnight(), tutorIds: borys.id })
        .set(await authHeader(test, anna))
        .expect(200);

      // Deliberate, and the reason the calendar has a filter at all: a school
      // coordinates by seeing when its colleagues are teaching. It also means a
      // tutor can read the *names* of a colleague's students, which is a known
      // cost of the feature rather than an oversight — asserted here so that
      // changing it is a decision somebody makes on purpose.
      expect((body as { id: string }[]).map((lesson) => lesson.id)).toEqual([
        borysLesson.id,
      ]);
    });

    it('gives a tutor only their own calendar when they ask for nothing', async () => {
      const { anna, annasStudent, school, borysLesson } = await aSchool();
      const mine = await makeLesson(test, {
        school,
        tutor: anna,
        student: annasStudent,
        startsAt: at(-1, 12),
      });

      const { body } = await request(test.server)
        .get('/api/lessons')
        .query(thisFortnight())
        .set(await authHeader(test, anna))
        .expect(200);

      const ids = (body as { id: string }[]).map((lesson) => lesson.id);
      expect(ids).toContain(mine.id);
      // The default is *mine*, not the school's. A calendar that opened on
      // everybody's lessons would be unreadable in a school of six.
      expect(ids).not.toContain(borysLesson.id);
    });

    it('shows the whole school to an admin without asking', async () => {
      const { admin, borysLesson } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/lessons')
        .query(thisFortnight())
        .set(await authHeader(test, admin))
        .expect(200);

      expect((body as { id: string }[]).map((lesson) => lesson.id)).toContain(
        borysLesson.id,
      );
    });

    it('gives both tutors the same subject list', async () => {
      const { anna, borys } = await aSchool();

      const hers = await request(test.server)
        .get('/api/subjects')
        .set(await authHeader(test, anna))
        .expect(200);
      const his = await request(test.server)
        .get('/api/subjects')
        .set(await authHeader(test, borys))
        .expect(200);

      // The vocabulary every record is written in belongs to the school, not to
      // whoever happened to add the word.
      expect(hers.body).toEqual(his.body);
    });
  });

  describe('a colleague’s students', () => {
    it('are left out of the roster', async () => {
      const { anna, annasStudent, borysStudent } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/students')
        .set(await authHeader(test, anna))
        .expect(200);

      const ids = (body as { id: string }[]).map((student) => student.id);
      expect(ids).toEqual([annasStudent.id]);
      expect(ids).not.toContain(borysStudent.id);
    });

    it('cannot be opened', async () => {
      const { anna, borysStudent } = await aSchool();

      await request(test.server)
        .get(`/api/students/${borysStudent.id}`)
        .set(await authHeader(test, anna))
        .expect(403);
    });

    it('cannot be edited', async () => {
      const { anna, borysStudent } = await aSchool();

      await request(test.server)
        .patch(`/api/students/${borysStudent.id}`)
        .set(await authHeader(test, anna))
        .send({ name: 'Renamed by a stranger' })
        .expect(403);

      const stored = await test.prisma.student.findUniqueOrThrow({
        where: { id: borysStudent.id },
      });
      expect(stored.name).toBe('Bohdan');
    });

    it('cannot be deleted', async () => {
      const { anna, borysStudent } = await aSchool();

      await request(test.server)
        .delete(`/api/students/${borysStudent.id}`)
        .set(await authHeader(test, anna))
        .expect(403);

      // Asserted against the database, not the status code. A refusal that had
      // already deleted the row would answer 403 just as convincingly.
      expect(
        await test.prisma.student.count({ where: { id: borysStudent.id } }),
      ).toBe(1);
    });

    it('cannot have their progress read', async () => {
      const { anna, borysStudent } = await aSchool();

      // Marks and attendance for somebody else's student, which is the whole of
      // what a progress card is.
      await request(test.server)
        .get(`/api/students/${borysStudent.id}/progress`)
        .set(await authHeader(test, anna))
        .expect(403);
    });

    it('cannot have their lessons listed', async () => {
      const { anna, borysStudent } = await aSchool();

      await request(test.server)
        .get(`/api/students/${borysStudent.id}/lessons`)
        .set(await authHeader(test, anna))
        .expect(403);
    });

    it('cannot be booked for', async () => {
      const { anna, borysStudent } = await aSchool();

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, anna))
        .send({
          studentId: borysStudent.id,
          startsAt: at(2).toISOString(),
          durationMinutes: 60,
        })
        .expect(403);
    });

    it('cannot be added to a group of one’s own', async () => {
      const { school, anna, borysStudent } = await aSchool();
      const annasGroup = await makeGroup(test, { school, tutor: anna });

      // The group is hers; the student is not. Reaching a student through a
      // container she owns would be the way round every rule above.
      await request(test.server)
        .post(`/api/groups/${annasGroup.id}/members`)
        .set(await authHeader(test, anna))
        .send({ studentId: borysStudent.id })
        .expect(403);

      expect(
        await test.prisma.groupMember.count({
          where: { studentId: borysStudent.id, groupId: annasGroup.id },
        }),
      ).toBe(0);
    });

    it('are all reachable by an admin', async () => {
      const { admin, borysStudent } = await aSchool();

      // The other half of every refusal above. Without this the file would pass
      // on a server that refused everybody, which is not the rule — it is a
      // different bug wearing the same shape.
      await request(test.server)
        .get(`/api/students/${borysStudent.id}`)
        .set(await authHeader(test, admin))
        .expect(200);

      await request(test.server)
        .patch(`/api/students/${borysStudent.id}`)
        .set(await authHeader(test, admin))
        .send({ name: 'Bohdan Renamed' })
        .expect(200);
    });
  });

  describe('a colleague’s lessons', () => {
    it('cannot be opened through the register', async () => {
      const { anna, borysLesson } = await aSchool();

      await request(test.server)
        .get(`/api/lessons/${borysLesson.id}/register`)
        .set(await authHeader(test, anna))
        .expect(404);
    });

    it('cannot be confirmed or cancelled', async () => {
      const { anna, borysLesson } = await aSchool();

      await request(test.server)
        .patch(`/api/lessons/${borysLesson.id}/status`)
        .set(await authHeader(test, anna))
        .send({ status: LessonStatus.CANCELLED })
        .expect(404);

      const stored = await test.prisma.lesson.findUniqueOrThrow({
        where: { id: borysLesson.id },
      });
      expect(stored.status).toBe(LessonStatus.SCHEDULED);
    });

    it('cannot be written up', async () => {
      const { anna, borysLesson, borysStudent } = await aSchool();

      // The register is where money moves — a mark charges a paid lesson — so
      // this is the most expensive door in the file.
      await request(test.server)
        .patch(`/api/lessons/${borysLesson.id}/journal`)
        .set(await authHeader(test, anna))
        .send({
          topic: 'Written by the wrong tutor',
          attendance: [{ studentId: borysStudent.id, status: 'PRESENT' }],
        })
        .expect(404);

      expect(
        await test.prisma.lessonAttendance.count({
          where: { lessonId: borysLesson.id },
        }),
      ).toBe(0);
      const student = await test.prisma.student.findUniqueOrThrow({
        where: { id: borysStudent.id },
      });
      expect(student.paidLessonsLeft).toBe(borysStudent.paidLessonsLeft);
    });

    it('cannot be marked up with a grade', async () => {
      const { anna, borysLesson, borysStudent } = await aSchool();

      // A real student, so the only thing that can refuse this is the lesson's
      // ownership. An invented id would have been rejected by validation and the
      // test would have passed without ever reaching the rule.
      await request(test.server)
        .post(`/api/lessons/${borysLesson.id}/grades`)
        .set(await authHeader(test, anna))
        .send({ studentId: borysStudent.id, kind: 'CLASSIC', value: 12 })
        .expect(404);

      expect(await test.prisma.grade.count()).toBe(0);
    });

    it('cannot have a note attached', async () => {
      const { anna, borysLesson } = await aSchool();

      await request(test.server)
        .post(`/api/lessons/${borysLesson.id}/notes`)
        .set(await authHeader(test, anna))
        .send({ text: 'Not mine to write on' })
        .expect(404);
    });

    it('are all reachable by an admin', async () => {
      const { admin, borysLesson } = await aSchool();

      await request(test.server)
        .patch(`/api/lessons/${borysLesson.id}/status`)
        .set(await authHeader(test, admin))
        .send({ status: LessonStatus.CANCELLED })
        .expect(200);
    });
  });

  describe('a colleague’s groups', () => {
    it('are left out of the list', async () => {
      const { anna, borysGroup } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/groups')
        .set(await authHeader(test, anna))
        .expect(200);

      expect((body as { id: string }[]).map((group) => group.id)).not.toContain(
        borysGroup.id,
      );
    });

    it('cannot be opened, renamed or dissolved', async () => {
      const { anna, borysGroup } = await aSchool();
      const header = await authHeader(test, anna);

      await request(test.server)
        .get(`/api/groups/${borysGroup.id}`)
        .set(header)
        .expect(404);
      await request(test.server)
        .patch(`/api/groups/${borysGroup.id}`)
        .set(header)
        .send({ name: 'Renamed by a stranger' })
        .expect(404);
      await request(test.server)
        .delete(`/api/groups/${borysGroup.id}`)
        .set(header)
        .expect(404);

      const stored = await test.prisma.group.findUniqueOrThrow({
        where: { id: borysGroup.id },
      });
      expect(stored.name).toBe('Bohdan and friends');
    });

    it('cannot have their membership changed', async () => {
      const { anna, annasStudent, borysGroup, borysStudent } = await aSchool();
      const header = await authHeader(test, anna);

      // Neither direction: not her student into his group, and not his student
      // out of it. Dissolving somebody else's class one member at a time is the
      // same harm as deleting it.
      await request(test.server)
        .post(`/api/groups/${borysGroup.id}/members`)
        .set(header)
        .send({ studentId: annasStudent.id })
        .expect(404);
      await request(test.server)
        .delete(`/api/groups/${borysGroup.id}/members/${borysStudent.id}`)
        .set(header)
        .expect(404);

      expect(
        await test.prisma.groupMember.count({
          where: { groupId: borysGroup.id },
        }),
      ).toBe(1);
    });

    it('cannot be booked for', async () => {
      const { anna, borysGroup } = await aSchool();

      await request(test.server)
        .post('/api/lessons')
        .set(await authHeader(test, anna))
        .send({
          groupId: borysGroup.id,
          startsAt: at(2).toISOString(),
          durationMinutes: 60,
        })
        .expect(404);
    });

    it('do not leak their members through a group lesson', async () => {
      const { school, anna, borys, borysGroup } = await aSchool();
      const lesson = await makeGroupLesson(test, {
        school,
        tutor: borys,
        group: borysGroup,
        startsAt: at(-2),
      });

      // A group lesson carries its members with it, so if the lesson were
      // reachable the roster would be too — the same names the group hides.
      await request(test.server)
        .get(`/api/lessons/${lesson.id}/register`)
        .set(await authHeader(test, anna))
        .expect(404);
    });
  });

  /**
   * Notes and marks have a second owner.
   *
   * Reaching the student is not enough: the note or the mark also belongs to
   * whoever wrote it. These use the admin's writing on the tutor's *own* student,
   * because that is the only way to test the author rule on its own — anything
   * written by a colleague sits on a student the caller cannot reach anyway, and
   * the first rule would answer before the second was ever asked.
   */
  describe('somebody else’s writing on one’s own student', () => {
    it('cannot have their mark corrected by the tutor', async () => {
      const { admin, anna, annasStudent } = await aSchool();
      const theirs = await makeGrade(test, {
        student: annasStudent,
        author: admin,
      });

      await request(test.server)
        .put(`/api/grades/${theirs.id}`)
        .set(await authHeader(test, anna))
        .send({ kind: 'CLASSIC', value: 1 })
        .expect(403);

      const stored = await test.prisma.grade.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(stored.value).toBe(10);
    });

    it('cannot have their mark deleted by the tutor', async () => {
      const { admin, anna, annasStudent } = await aSchool();
      const theirs = await makeGrade(test, {
        student: annasStudent,
        author: admin,
      });

      await request(test.server)
        .delete(`/api/grades/${theirs.id}`)
        .set(await authHeader(test, anna))
        .expect(403);

      expect(await test.prisma.grade.count({ where: { id: theirs.id } })).toBe(
        1,
      );
    });

    it('cannot have their note removed by the tutor', async () => {
      const { admin, anna, annasStudent } = await aSchool();

      const written = await request(test.server)
        .post(`/api/students/${annasStudent.id}/notes`)
        .set(await authHeader(test, admin))
        .send({ text: 'A word from the head of the school' })
        .expect(201);

      await request(test.server)
        .delete(`/api/notes/${(written.body as { id: string }).id}`)
        .set(await authHeader(test, anna))
        .expect(403);

      expect(await test.prisma.note.count()).toBe(1);
    });

    it('is still readable by the tutor whose student it is about', async () => {
      const { admin, anna, annasStudent } = await aSchool();

      await request(test.server)
        .post(`/api/students/${annasStudent.id}/notes`)
        .set(await authHeader(test, admin))
        .send({ text: 'Needs more practice with the past tense' })
        .expect(201);

      const { body } = await request(test.server)
        .get(`/api/students/${annasStudent.id}/notes`)
        .set(await authHeader(test, anna))
        .expect(200);

      // Refusing to *delete* is not refusing to see. A tutor who could not read
      // what the school had written about their own student would be worse off
      // than before anybody wrote it.
      expect(body).toHaveLength(1);
    });
  });

  /**
   * What each of them is told the numbers are.
   *
   * A report is the one place where a colleague's work becomes visible as a
   * total, so the boundary is about aggregates rather than rows.
   */
  describe('the numbers each of them sees', () => {
    it('counts only a tutor’s own work in their report', async () => {
      const { anna, school, annasStudent } = await aSchool();
      await makeLesson(test, {
        school,
        tutor: anna,
        student: annasStudent,
        startsAt: at(-1, 9),
        status: LessonStatus.COMPLETED,
        durationMinutes: 45,
      });

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, anna))
        .expect(200);

      expect(body.scope).toEqual({ tutorId: anna.id });
      expect(body.minutesTaught).toBe(45);
      // A tutor gets no per-tutor table at all: the breakdown exists to compare
      // colleagues, which is an admin's question.
      expect(body.byTutor).toBeNull();
    });

    it('refuses a tutor asking for a colleague’s numbers', async () => {
      const { anna, borys } = await aSchool();

      await request(test.server)
        .get('/api/reports/summary')
        .query({ tutorId: borys.id })
        .set(await authHeader(test, anna))
        .expect(403);
    });

    it('lists only a tutor’s own debtors', async () => {
      const { anna, borys, school } = await aSchool();
      await makeStudent(test, {
        school,
        tutor: borys,
        name: 'Owing to Borys',
        paidLessonsLeft: -2,
      });
      await makeStudent(test, {
        school,
        tutor: anna,
        name: 'Owing to Anna',
        paidLessonsLeft: -1,
      });

      const { body } = await request(test.server)
        .get('/api/reports/debtors')
        .set(await authHeader(test, anna))
        .expect(200);

      const names = (body as { name: string }[]).map((row) => row.name);
      expect(names).toContain('Owing to Anna');
      // Who owes a colleague money is the colleague's business, and an admin's.
      expect(names).not.toContain('Owing to Borys');
    });

    it('gives an admin the whole school and a table of who did what', async () => {
      const { admin, anna, borys } = await aSchool();

      const { body } = await request(test.server)
        .get('/api/reports/summary')
        .set(await authHeader(test, admin))
        .expect(200);

      expect(body.scope).toEqual({ tutorId: null });
      expect(body.byTutor).not.toBeNull();

      const named = await request(test.server)
        .get('/api/reports/summary')
        .query({ tutorId: borys.id })
        .set(await authHeader(test, admin))
        .expect(200);

      expect(named.body.scope).toEqual({ tutorId: borys.id });
      expect(anna.id).not.toBe(borys.id);
    });
  });

  /**
   * Running the school is the admin's, and not delegable.
   *
   * These are `@Roles(ADMIN)` rather than capabilities, and the difference is the
   * point: a capability can be handed out, and the ability to hand out
   * capabilities cannot be.
   */
  describe('running the school', () => {
    it('does not let a tutor rename the school', async () => {
      const { anna } = await aSchool();

      await request(test.server)
        .patch('/api/schools/current')
        .set(await authHeader(test, anna))
        .send({ name: 'Anna Academy' })
        .expect(403);
    });

    it('does not let a tutor change what the school teaches', async () => {
      const { anna } = await aSchool();

      await request(test.server)
        .post('/api/subjects')
        .set(await authHeader(test, anna))
        .send({ name: 'Astronomy' })
        .expect(403);
    });

    it('does not let a tutor grant themselves a capability', async () => {
      const { anna } = await aSchool();

      // The one that would unlock everything else in this file.
      await request(test.server)
        .patch(`/api/schools/current/members/${anna.id}/addons`)
        .set(await authHeader(test, anna))
        .send({ addons: [AddonKey.INVITE_TUTORS] })
        .expect(403);
    });

    it('does not let a tutor take a colleague’s capabilities away', async () => {
      const { anna, borys } = await aSchool();

      await request(test.server)
        .patch(`/api/schools/current/members/${borys.id}/addons`)
        .set(await authHeader(test, anna))
        .send({ addons: [] })
        .expect(403);

      const stored = await test.prisma.userAddon.count({
        where: { userId: borys.id },
      });
      expect(stored).toBe(1);
    });

    it('does not let a tutor without the capability invite anybody', async () => {
      const { anna } = await aSchool();

      await request(test.server)
        .post('/api/invitations')
        .set(await authHeader(test, anna))
        .send({ email: 'newcomer@example.test' })
        .expect(403);
    });

    it('does not let a tutor announce to the school', async () => {
      const { anna } = await aSchool();

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, anna))
        .send({ text: 'Everybody please read this' })
        .expect(403);
    });
  });

  /**
   * One person's settings are one person's.
   *
   * Small, and worth stating: these routes take no id, so the only thing that
   * could go wrong is them reading the wrong session — which is exactly the kind
   * of mistake that shows up nowhere until two people use the app at once.
   */
  describe('what belongs to one person alone', () => {
    it('keeps each tutor’s preferences to themselves', async () => {
      const { anna, borys } = await aSchool();

      await request(test.server)
        .patch('/api/users/me/config')
        .set(await authHeader(test, anna))
        .send({ lessonReminderMinutes: 120 })
        .expect(200);

      const { body } = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, borys))
        .expect(200);

      expect(body.config.lessonReminderMinutes).not.toBe(120);
    });

    it('shows each of them only their own notifications', async () => {
      const { admin, anna, borys } = await aSchool();

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, admin))
        .send({ text: 'Parents evening on Thursday' })
        .expect(201);

      const hers = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, anna))
        .expect(200);
      const his = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, borys))
        .expect(200);

      // Same announcement, one row each: read state is per person, so marking it
      // read must not mark it read for the school.
      expect(hers.body).toHaveLength(1);
      expect(his.body).toHaveLength(1);
      expect((hers.body as { id: string }[])[0].id).not.toBe(
        (his.body as { id: string }[])[0].id,
      );
    });

    it('does not let one of them mark the other’s notification read', async () => {
      const { admin, anna, borys } = await aSchool();

      await request(test.server)
        .post('/api/notifications/announcements')
        .set(await authHeader(test, admin))
        .send({ text: 'Parents evening on Thursday' })
        .expect(201);

      const his = await request(test.server)
        .get('/api/notifications')
        .set(await authHeader(test, borys))
        .expect(200);
      const hisId = (his.body as { id: string }[])[0].id;

      // 204, not 404, and that is the right answer: the route is idempotent, so
      // it reports that there is nothing left to do rather than whether the id
      // exists — which is also the answer that discloses nothing. What matters
      // is the row, and the row is scoped to its own recipient.
      await request(test.server)
        .post(`/api/notifications/${hisId}/read`)
        .set(await authHeader(test, anna))
        .expect(204);

      const stored = await test.prisma.notification.findUniqueOrThrow({
        where: { id: hisId },
      });
      expect(stored.readAt).toBeNull();
    });
  });
});
