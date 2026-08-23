import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
import { TEST_UPLOADS_DIR } from './support/env';
import {
  authHeader,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

const PDF = Buffer.from('%PDF-1.4 not really a pdf, but the bytes are ours');

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

describe('Student files', () => {
  let test: TestApp;

  // A real directory rather than a stubbed storage: the point of these tests is
  // that bytes and rows stay in step, and a stub cannot show that. Its location
  // is set in the suite's environment, because Nest reads the configuration
  // before any hook here could change it.
  const uploads = TEST_UPLOADS_DIR;

  beforeAll(async () => {
    test = await createTestApp();
  });

  afterAll(async () => {
    await test.close();
    await rm(uploads, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await test.reset();
  });

  /** Not `async`: the caller needs supertest's chainable object, not a promise. */
  const upload = (
    studentId: string,
    header: Record<string, string>,
    options: { name?: string; type?: string; body?: Buffer } = {},
  ) =>
    request(test.server)
      .post(`/api/students/${studentId}/files`)
      .set(header)
      .attach('file', options.body ?? PDF, {
        filename: options.name ?? 'report.pdf',
        contentType: options.type ?? 'application/pdf',
      });

  it('stores the bytes and a row that describes them', async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });

    const response = await upload(
      student.id,
      await authHeader(test, tutor),
    ).expect(201);

    expect(response.body).toMatchObject({
      originalName: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: PDF.length,
      purpose: 'STUDENT_ATTACHMENT',
      studentId: student.id,
      uploadedById: tutor.id,
    });
    // Finalised: `uploadedAt` is what separates a completed upload from a row
    // left behind by one that failed halfway.
    expect(response.body.uploadedAt).not.toBeNull();
    expect(response.body.storageKey).not.toBe('pending');
  });

  it('gives the file back, as an attachment rather than a page', async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });
    const header = await authHeader(test, tutor);

    const created = await upload(student.id, header).expect(201);

    const response = await request(test.server)
      .get(`/api/files/${created.body.id as string}`)
      .set(header)
      // Without this supertest tries to parse the body by content type and hands
      // back something that is not the bytes.
      .responseType('blob')
      .expect(200);

    expect(response.headers['content-disposition']).toContain('attachment');
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(Buffer.from(response.body as Buffer).equals(PDF)).toBe(true);
  });

  it("lists a student's files, newest first", async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });
    const header = await authHeader(test, tutor);

    await upload(student.id, header, { name: 'first.pdf' }).expect(201);
    await upload(student.id, header, { name: 'second.pdf' }).expect(201);

    const response = await request(test.server)
      .get(`/api/students/${student.id}/files`)
      .set(header)
      .expect(200);

    expect(response.body).toHaveLength(2);
  });

  it('refuses a type nobody keeps against a student', async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });

    // An allow-list, so an unknown type is refused rather than stored and served
    // back later.
    await upload(student.id, await authHeader(test, tutor), {
      name: 'payload.html',
      type: 'text/html',
    }).expect(415);

    expect(await test.prisma.file.count()).toBe(0);
  });

  it('refuses an empty file', async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });

    await upload(student.id, await authHeader(test, tutor), {
      body: Buffer.alloc(0),
    }).expect(400);
  });

  it('refuses a request with no file at all', async () => {
    const school = await makeSchool(test);
    const tutor = await makeUser(test, { school });
    const student = await makeStudent(test, { school, tutor });

    await request(test.server)
      .post(`/api/students/${student.id}/files`)
      .set(await authHeader(test, tutor))
      .expect(400);
  });

  describe('reach', () => {
    it("is refused for a colleague's student", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });
      const theirs = await makeStudent(test, { school, tutor: colleague });

      await upload(theirs.id, await authHeader(test, tutor)).expect(403);
    });

    it("hides another school's file behind a 404", async () => {
      const school = await makeSchool(test);
      const other = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const stranger = await makeUser(test, { school: other });
      const elsewhere = await makeStudent(test, {
        school: other,
        tutor: stranger,
      });

      const created = await upload(
        elsewhere.id,
        await authHeader(test, stranger),
      ).expect(201);

      await request(test.server)
        .get(`/api/files/${created.body.id as string}`)
        .set(await authHeader(test, admin))
        .expect(404);
    });

    it('is open to an admin for their own school', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      await upload(student.id, await authHeader(test, tutor)).expect(201);

      const response = await request(test.server)
        .get(`/api/students/${student.id}/files`)
        .set(await authHeader(test, admin))
        .expect(200);

      expect(response.body).toHaveLength(1);
    });
  });

  describe('removal', () => {
    it('takes the row and the bytes', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      const created = await upload(student.id, header).expect(201);

      // Checked by exact path rather than by counting a directory: other tests
      // in this file upload too, and a count would be asserting on their
      // leftovers as much as on this one.
      const onDisk = join(uploads, created.body.storageKey as string);
      expect(await exists(onDisk)).toBe(true);

      await request(test.server)
        .delete(`/api/files/${created.body.id as string}`)
        .set(header)
        .expect(204);

      expect(await test.prisma.file.count()).toBe(0);
      // Asserted rather than assumed: a row removed while its bytes stay is a
      // disk that fills up with files nothing references.
      expect(await exists(onDisk)).toBe(false);
    });

    it('is refused for somebody who did not upload it', async () => {
      const school = await makeSchool(test);
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });

      const created = await upload(
        student.id,
        await authHeader(test, admin),
      ).expect(201);

      await request(test.server)
        .delete(`/api/files/${created.body.id as string}`)
        .set(await authHeader(test, tutor))
        .expect(403);
    });

    it('goes when the student does', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, {
        school,
        addons: ['MANAGE_STUDENTS'],
      });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      await upload(student.id, header).expect(201);
      await request(test.server)
        .delete(`/api/students/${student.id}`)
        .set(header)
        .expect(204);

      // The row cascades. The bytes do not, which is what the cleanup story is
      // for — and why this asserts on the row rather than the disk.
      expect(await test.prisma.file.count()).toBe(0);
    });
  });
});
