import request from 'supertest';

import { AddonKey, UserRole } from '../generated/prisma/enums';
import { AddonsService } from '../src/addons/addons.service';
import { authHeader, makeSchool, makeUser } from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

describe('Capabilities', () => {
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

  const setAddons = async (
    admin: Parameters<typeof authHeader>[1],
    userId: string,
    addons: string[],
  ) =>
    request(test.server)
      .patch(`/api/schools/current/members/${userId}/addons`)
      .set(await authHeader(test, admin))
      .send({ addons });

  it('grants what the admin submitted', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school });

    const response = await setAddons(admin, tutor.id, [
      'INVITE_TUTORS',
      'MANAGE_STUDENTS',
    ]);

    expect(response.status).toBe(200);
    expect(response.body.sort()).toEqual(['INVITE_TUTORS', 'MANAGE_STUDENTS']);
  });

  it('replaces the previous set rather than adding to it', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, {
      school,
      addons: ['INVITE_TUTORS', 'BROADCAST_ANNOUNCEMENTS'],
    });

    await setAddons(admin, tutor.id, ['MANAGE_STUDENTS']);

    // The admin UI submits what it wants to be true, so the operation has to be
    // idempotent and leave nothing half-applied.
    const rows = await test.prisma.userAddon.findMany({
      where: { userId: tutor.id },
    });
    expect(rows.map((row) => row.addon)).toEqual(['MANAGE_STUDENTS']);
  });

  it('is a no-op when the same set is submitted twice', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school });

    await setAddons(admin, tutor.id, ['MANAGE_STUDENTS']);
    const response = await setAddons(admin, tutor.id, ['MANAGE_STUDENTS']);

    expect(response.status).toBe(200);
    expect(
      await test.prisma.userAddon.count({ where: { userId: tutor.id } }),
    ).toBe(1);
  });

  it('takes everything away when an empty set is submitted', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school, addons: ['INVITE_TUTORS'] });

    await setAddons(admin, tutor.id, []);

    expect(
      await test.prisma.userAddon.count({ where: { userId: tutor.id } }),
    ).toBe(0);
  });

  it('records who granted it, so the question can be answered later', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school });

    await setAddons(admin, tutor.id, ['MANAGE_STUDENTS']);

    const row = await test.prisma.userAddon.findFirstOrThrow();
    expect(row.enabledById).toBe(admin.id);
  });

  it('reaches the tutor on their next session, not on a separate request', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school });

    await setAddons(admin, tutor.id, ['MANAGE_STUDENTS']);

    const session = await request(test.server)
      .get('/api/auth/me')
      .set(await authHeader(test, tutor))
      .expect(200);

    expect(session.body.addons).toEqual(['MANAGE_STUDENTS']);
  });

  it('refuses a capability name that does not exist', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const tutor = await makeUser(test, { school });

    const response = await setAddons(admin, tutor.id, ['DELETE_EVERYTHING']);

    expect(response.status).toBe(400);
  });

  it('cannot be handed out by a tutor, however senior', async () => {
    const school = await makeSchool(test);
    const senior = await makeUser(test, {
      school,
      addons: ['INVITE_TUTORS', 'BROADCAST_ANNOUNCEMENTS', 'MANAGE_STUDENTS'],
    });
    const tutor = await makeUser(test, { school });

    // Granting permissions is checked by role, not by capability: if it were
    // delegable the boundary would mean nothing.
    await request(test.server)
      .patch(`/api/schools/current/members/${tutor.id}/addons`)
      .set(await authHeader(test, senior))
      .send({ addons: ['MANAGE_STUDENTS'] })
      .expect(403);
  });

  it('cannot reach a member of another school', async () => {
    const school = await makeSchool(test);
    const other = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const stranger = await makeUser(test, { school: other });

    // 404 rather than 403, so the endpoint cannot be used to discover accounts.
    await request(test.server)
      .patch(`/api/schools/current/members/${stranger.id}/addons`)
      .set(await authHeader(test, admin))
      .send({ addons: ['MANAGE_STUDENTS'] })
      .expect(404);
  });

  it('refuses to grant anything to another admin', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const peer = await makeUser(test, { school, role: UserRole.ADMIN });

    await request(test.server)
      .patch(`/api/schools/current/members/${peer.id}/addons`)
      .set(await authHeader(test, admin))
      .send({ addons: ['MANAGE_STUDENTS'] })
      .expect(403);
  });

  it('holds every capability for an admin without storing a single grant', async () => {
    const school = await makeSchool(test);
    const admin = await makeUser(test, { school, role: UserRole.ADMIN });
    const header = await authHeader(test, admin);

    // An admin is the person who grants capabilities, so requiring them to grant
    // themselves permission to grant permissions is a loop with no first step.
    await request(test.server)
      .post('/api/invitations')
      .set(header)
      .send({ email: 'invited@example.test' })
      .expect(201);
    await request(test.server)
      .post('/api/students')
      .set(header)
      .send({ name: 'Student' })
      .expect(201);
    await request(test.server)
      .post('/api/notifications/announcements')
      .set(header)
      .send({ text: 'Everything works' })
      .expect(201);

    expect(await test.prisma.userAddon.count()).toBe(0);
  });

  describe('the roster', () => {
    it('reports what each member actually holds', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const senior = await makeUser(test, {
        school,
        addons: ['INVITE_TUTORS'],
      });
      const plain = await makeUser(test, { school });

      const response = await request(test.server)
        .get('/api/schools/current/tutors')
        .set(await authHeader(test, admin))
        .expect(200);

      const listed = (id: string) =>
        response.body.find((member: { id: string }) => member.id === id);

      // The screen that lists members is the screen that edits their
      // capabilities, and it submits the whole set it wants to be true. Without
      // these, every toggle would compute that set from an empty one.
      expect(listed(senior.id).addons).toEqual(['INVITE_TUTORS']);
      expect(listed(plain.id).addons).toEqual([]);
    });

    it('does not let a toggle strip a capability the member already had', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school, addons: ['INVITE_TUTORS'] });
      const header = await authHeader(test, admin);

      // Exactly what the app does: read the member, add one to what it reports,
      // submit the result. If the read had returned nothing, this would silently
      // remove INVITE_TUTORS.
      const roster = await request(test.server)
        .get('/api/schools/current/tutors')
        .set(header)
        .expect(200);

      const current: string[] = roster.body.find(
        (member: { id: string }) => member.id === tutor.id,
      ).addons;

      await setAddons(admin, tutor.id, [...current, 'MANAGE_STUDENTS']);

      const rows = await test.prisma.userAddon.findMany({
        where: { userId: tutor.id },
      });
      expect(rows.map((row) => row.addon).sort()).toEqual([
        'INVITE_TUTORS',
        'MANAGE_STUDENTS',
      ]);
    });
  });

  describe('an admin', () => {
    it('holds every capability in the session, with no grant rows', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, admin))
        .expect(200);

      // Compared against the whole enum rather than a written-out list, so adding
      // a capability without extending the rule fails here.
      expect([...response.body.addons].sort()).toEqual(
        [...Object.values(AddonKey)].sort(),
      );
    });

    it('holds every capability the moment they are created, not after a grant', async () => {
      // Registration is the only path that makes an admin from nothing, so this
      // is where "always" has to be true from the first request.
      const session = await request(test.server)
        .post('/api/schools/register')
        .send({
          schoolName: 'Fresh School',
          adminName: 'Olha',
          adminEmail: 'fresh@example.test',
          adminPassword: 'correct-horse-battery',
        })
        .expect(201);

      expect([...session.body.user.addons].sort()).toEqual(
        [...Object.values(AddonKey)].sort(),
      );
      expect(await test.prisma.userAddon.count()).toBe(0);
    });

    it('keeps every capability after their grants are explicitly emptied', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      // There are no rows to remove, but a future path that tried would not be
      // able to take anything away — the rule is not stored, it is decided.
      await test.prisma.userAddon.deleteMany({ where: { userId: admin.id } });

      const response = await request(test.server)
        .get('/api/auth/me')
        .set(await authHeader(test, admin))
        .expect(200);

      expect([...response.body.addons].sort()).toEqual(
        [...Object.values(AddonKey)].sort(),
      );
    });

    it('reports every capability in a roster too, if one ever lists them', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      // The roster currently lists tutors only, so this checks the mapping the
      // roster is built from rather than the response: the rule must hold there
      // as well, or including admins later would show them holding nothing.
      const map = await test.app.get(AddonsService).mapForSchool(school.id);

      expect([...map[admin.id]].sort()).toEqual(
        [...Object.values(AddonKey)].sort(),
      );
    });
  });
});
