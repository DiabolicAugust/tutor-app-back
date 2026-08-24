import { access, rm } from 'node:fs/promises';
import { join } from 'node:path';

import request from 'supertest';

import { UserRole } from '../generated/prisma/enums';
import { TEST_UPLOADS_DIR } from './support/env';
import {
  authHeader,
  makeLesson,
  makeSchool,
  makeStudent,
  makeUser,
} from './support/factories';
import { createTestApp, type TestApp } from './support/test-app';

const PDF = pdf('not really a pdf, but the bytes are ours');

/**
 * A buffer that starts like a PDF.
 *
 * Uploads are checked against the *bytes* now, not only the declared type, so a
 * test that attaches the word "worksheet" as `application/pdf` is rejected —
 * correctly. Each of these still carries its own text, so an assertion about
 * which file came back still means something.
 */
function pdf(label: string): Buffer {
  return Buffer.from(`%PDF-1.4 ${label}`);
}

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

  describe("a tutor's own library", () => {
    it('stores material that belongs to nobody in particular', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      const response = await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', pdf('worksheet'), {
          filename: 'unit-5.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      expect(response.body).toMatchObject({
        originalName: 'unit-5.pdf',
        purpose: 'TUTOR_LIBRARY',
        studentId: null,
      });
      // Finalised, so the bytes are known to be on disk rather than attempted.
      expect(response.body.uploadedAt).not.toBeNull();
    });

    it('lists only your own shelf', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });

      await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, colleague))
        .attach('file', pdf('theirs'), {
          filename: 'theirs.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const response = await request(test.server)
        .get('/api/files')
        .set(await authHeader(test, tutor))
        .expect(200);

      expect(response.body).toHaveLength(0);
    });

    it('keeps a library separate from a student’s documents', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post(`/api/students/${student.id}/files`)
        .set(header)
        .attach('file', pdf('report'), {
          filename: 'report.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      // A student's document is not library material, and the shelf must not
      // quietly fill up with everything ever uploaded.
      const library = await request(test.server)
        .get('/api/files')
        .set(header)
        .expect(200);

      expect(library.body).toHaveLength(0);
    });

    it('downloads what you put there', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);

      const created = await request(test.server)
        .post('/api/files')
        .set(header)
        .attach('file', pdf('worksheet bytes'), {
          filename: 'unit-5.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const response = await request(test.server)
        .get(`/api/files/${created.body.id}`)
        .set(header)
        .expect(200);

      // The whole buffer, header included: what went up is what comes back.
      expect(response.body.toString()).toBe(pdf('worksheet bytes').toString());
    });

    it("hides a colleague's library file behind a 404", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const colleague = await makeUser(test, { school });

      const created = await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, colleague))
        .attach('file', pdf('theirs'), {
          filename: 'theirs.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      // Not 403: a personal shelf should not confirm what is on it.
      await request(test.server)
        .get(`/api/files/${created.body.id}`)
        .set(await authHeader(test, tutor))
        .expect(404);
    });

    it('lets an admin reach one, because the account is theirs to answer for', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      const created = await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', pdf('worksheet'), {
          filename: 'unit-5.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      await request(test.server)
        .get(`/api/files/${created.body.id}`)
        .set(await authHeader(test, admin))
        .expect(200);
    });

    it('refuses a type nobody keeps as teaching material', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', Buffer.from('MZ'), {
          filename: 'thing.exe',
          contentType: 'application/x-msdownload',
        })
        .expect(415);
    });

    it('lets you clear your own shelf', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);

      const created = await request(test.server)
        .post('/api/files')
        .set(header)
        .attach('file', pdf('worksheet'), {
          filename: 'unit-5.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      await request(test.server)
        .delete(`/api/files/${created.body.id}`)
        .set(header)
        .expect(204);

      const response = await request(test.server)
        .get('/api/files')
        .set(header)
        .expect(200);

      expect(response.body).toHaveLength(0);
    });
  });

  describe('what it refuses to store', () => {
    it('rejects bytes that are not the type they claim to be', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      // A Windows executable, announced as a PNG. The declared type is on the
      // allow-list, so this is exactly the upload the list alone would take.
      await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', Buffer.from('MZ\u0090\u0000\u0003 this is a program'), {
          filename: 'holiday.png',
          contentType: 'image/png',
        })
        .expect(415);
    });

    it('accepts a real one of each type it advertises', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const header = await authHeader(test, tutor);

      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from('the rest of a png'),
      ]);

      await request(test.server)
        .post('/api/files')
        .set(header)
        .attach('file', png, {
          filename: 'chart.png',
          contentType: 'image/png',
        })
        .expect(201);

      // Plain text has no signature to check, so the rule is that it reads as
      // text at all — which is what keeps "text/plain" from being the way in.
      await request(test.server)
        .post('/api/files')
        .set(header)
        .attach('file', Buffer.from('homework, in words'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(201);

      await request(test.server)
        .post('/api/files')
        .set(header)
        .attach('file', Buffer.from('binary\u0000inside'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        })
        .expect(415);
    });

    it('refuses an upload once the school has used its storage', async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });

      // A row rather than two gigabytes of request body: the quota is summed
      // from what the school has stored, so this is the same state without the
      // wait.
      // Two rows rather than one: `sizeBytes` is a 32-bit integer, so a single
      // row cannot hold the whole allowance. It does not need to — a real school
      // reaches the limit in hundreds of files, and no one file may exceed
      // `MAX_UPLOAD_MB` anyway.
      await test.prisma.file.createMany({
        data: [0, 1].map((index) => ({
          storageKey: `quota-probe-${school.id}-${index}`,
          originalName: 'archive.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1_100 * 1024 * 1024,
          purpose: 'TUTOR_LIBRARY' as const,
          schoolId: school.id,
          uploadedById: tutor.id,
          uploadedAt: new Date(),
        })),
      });

      await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', pdf('one more'), {
          filename: 'one-more.pdf',
          contentType: 'application/pdf',
        })
        .expect(413);
    });

    it("counts one school's storage separately from another's", async () => {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });

      await test.prisma.file.createMany({
        data: [0, 1].map((index) => ({
          storageKey: `quota-probe-${other.id}-${index}`,
          originalName: 'archive.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 1_100 * 1024 * 1024,
          purpose: 'TUTOR_LIBRARY' as const,
          schoolId: other.id,
          uploadedById: stranger.id,
          uploadedAt: new Date(),
        })),
      });

      // A neighbour filling their allowance must not stop this school working.
      await request(test.server)
        .post('/api/files')
        .set(await authHeader(test, tutor))
        .attach('file', pdf('unaffected'), {
          filename: 'unaffected.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);
    });
  });

  describe("a lesson's material", () => {
    /** A lesson, its tutor, and the school they are both in. */
    async function seedLesson() {
      const school = await makeSchool(test);
      const tutor = await makeUser(test, { school });
      const student = await makeStudent(test, { school, tutor });
      const lesson = await makeLesson(test, {
        school,
        tutor,
        student,
        startsAt: new Date(),
      });

      return { school, tutor, student, lesson };
    }

    it('is stored against the lesson and comes back with it', async () => {
      const { lesson, tutor } = await seedLesson();
      const header = await authHeader(test, tutor);

      const created = await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(header)
        .attach('file', pdf('the worksheet'), {
          filename: 'unit-5.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      expect(created.body).toMatchObject({
        originalName: 'unit-5.pdf',
        purpose: 'LESSON_ATTACHMENT',
        lessonId: lesson.id,
      });

      const listed = await request(test.server)
        .get(`/api/lessons/${lesson.id}/files`)
        .set(header)
        .expect(200);

      expect(listed.body).toHaveLength(1);
      expect(listed.body[0].id).toBe(created.body.id);
    });

    it("does not appear among the student's own documents", async () => {
      const { lesson, student, tutor } = await seedLesson();
      const header = await authHeader(test, tutor);

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(header)
        .attach('file', pdf('handed out in class'), {
          filename: 'worksheet.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      // A group lesson hands the same sheet to everybody, so it belongs to the
      // hour rather than to any one person's file.
      const documents = await request(test.server)
        .get(`/api/students/${student.id}/files`)
        .set(header)
        .expect(200);

      expect(documents.body).toHaveLength(0);
    });

    it("is hidden from a colleague, like the lesson itself", async () => {
      const { school, lesson, tutor } = await seedLesson();
      const colleague = await makeUser(test, { school });

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, tutor))
        .attach('file', pdf('mine'), {
          filename: 'mine.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      // Not-found, not forbidden: the lesson answers the same way, and this
      // borrows that rule rather than inventing a second one.
      await request(test.server)
        .get(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, colleague))
        .expect(404);
    });

    it('is reachable by an admin, like the lesson itself', async () => {
      const { school, lesson, tutor } = await seedLesson();
      const admin = await makeUser(test, { school, role: UserRole.ADMIN });

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, tutor))
        .attach('file', pdf('theirs'), {
          filename: 'theirs.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      const listed = await request(test.server)
        .get(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, admin))
        .expect(200);

      expect(listed.body).toHaveLength(1);
    });

    it("cannot be reached from another school", async () => {
      const { lesson } = await seedLesson();
      const other = await makeSchool(test);
      const stranger = await makeUser(test, { school: other });

      await request(test.server)
        .get(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, stranger))
        .expect(404);

      await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, stranger))
        .attach('file', pdf('borrowed'), {
          filename: 'borrowed.pdf',
          contentType: 'application/pdf',
        })
        .expect(404);
    });

    it('goes when the lesson goes', async () => {
      const { lesson, tutor } = await seedLesson();

      const created = await request(test.server)
        .post(`/api/lessons/${lesson.id}/files`)
        .set(await authHeader(test, tutor))
        .attach('file', pdf('transient'), {
          filename: 'transient.pdf',
          contentType: 'application/pdf',
        })
        .expect(201);

      await test.prisma.lesson.delete({ where: { id: lesson.id } });

      // The row cascades. A file pointing at a lesson that no longer exists is
      // unreachable and nothing would ever collect it.
      const left = await test.prisma.file.findUnique({
        where: { id: created.body.id },
      });
      expect(left).toBeNull();
    });
  });
});
