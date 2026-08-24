import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { File, User } from '../../generated/prisma/client';
import { FilePurpose } from '../../generated/prisma/enums';
import type { Env } from '../config/env';
import { LessonsService } from '../lessons/lessons.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import { bytesLookLike } from './file-signatures';
import { StorageService } from './storage.service';

/** What a caller hands over: the bytes, plus what the browser said about them. */
export type IncomingFile = {
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
};

/**
 * Types a tutor plausibly keeps — against a student, or on their own shelf.
 *
 * An allow-list rather than a deny-list: the set of dangerous types grows over
 * time and the set of useful ones does not, so guessing wrong on an allow-list
 * costs somebody an upload while guessing wrong on a deny-list costs everybody.
 */
const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);

const MB = 1024 * 1024;

@Injectable()
export class FilesService {
  private readonly maxBytes: number;
  private readonly maxSchoolBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly students: StudentsService,
    private readonly lessons: LessonsService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MAX_UPLOAD_MB', { infer: true }) * MB;
    this.maxSchoolBytes =
      config.get('MAX_SCHOOL_STORAGE_MB', { infer: true }) * MB;
  }

  listForStudent(user: User, studentId: string): Promise<File[]> {
    return this.students.findOne(user, studentId).then((student) =>
      this.prisma.file.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  /**
   * Stores a document against a student.
   *
   * The row is written **before** the bytes and finalised after. If writing the
   * bytes fails, what remains is a row with no `uploadedAt` — a record that
   * something was attempted, which can be found and cleaned up. The other order
   * would leave bytes on disk that nothing in the database knows about, and
   * nothing can find those.
   */
  async uploadForStudent(
    user: User,
    studentId: string,
    incoming: IncomingFile,
  ): Promise<File> {
    const student = await this.students.findOne(user, studentId);
    this.assertAcceptable(incoming);
    await this.assertWithinQuota(student.schoolId, incoming.size);

    const row = await this.prisma.file.create({
      data: {
        storageKey: 'pending',
        originalName: incoming.originalName.slice(0, 255),
        mimeType: incoming.mimeType,
        sizeBytes: incoming.size,
        purpose: FilePurpose.STUDENT_ATTACHMENT,
        schoolId: student.schoolId,
        uploadedById: user.id,
        studentId: student.id,
      },
    });

    // The key needs the row id, so it is set on the way back rather than up
    // front. `storageKey` is unique, hence the placeholder rather than null.
    const storageKey = this.storage.keyFor(student.schoolId, row.id);
    await this.storage.save(storageKey, incoming.buffer);

    return this.prisma.file.update({
      where: { id: row.id },
      data: { storageKey, uploadedAt: new Date() },
    });
  }

  /**
   * A tutor's own library — the material they keep for themselves.
   *
   * Scoped to the caller rather than the school, including for an admin: an
   * admin's library is their own library, and quietly showing them everybody's
   * worksheets is not what "admin sees everything" should mean for a personal
   * shelf. Reaching a colleague's file by id is a different question, answered in
   * `findReachable`.
   */
  listOwnLibrary(user: User): Promise<File[]> {
    return this.prisma.file.findMany({
      where: {
        schoolId: user.schoolId,
        purpose: FilePurpose.TUTOR_LIBRARY,
        uploadedById: user.id,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Stores material in the caller's own library.
   *
   * Same write order as a student's document, for the same reason: the row first,
   * so a failed upload leaves something findable rather than orphaned bytes.
   */
  async uploadToLibrary(user: User, incoming: IncomingFile): Promise<File> {
    this.assertAcceptable(incoming);
    // The same quota, and deliberately the same pool: it is the school's storage
    // either way, so a personal shelf cannot be the way around the limit.
    await this.assertWithinQuota(user.schoolId, incoming.size);

    const row = await this.prisma.file.create({
      data: {
        storageKey: 'pending',
        originalName: incoming.originalName.slice(0, 255),
        mimeType: incoming.mimeType,
        sizeBytes: incoming.size,
        purpose: FilePurpose.TUTOR_LIBRARY,
        schoolId: user.schoolId,
        uploadedById: user.id,
      },
    });

    const storageKey = this.storage.keyFor(user.schoolId, row.id);
    await this.storage.save(storageKey, incoming.buffer);

    return this.prisma.file.update({
      where: { id: row.id },
      data: { storageKey, uploadedAt: new Date() },
    });
  }

  /**
   * The row and a stream of its bytes, if this caller may reach it.
   *
   * The stream is awaited here rather than handed on as a promise: the local
   * driver opens synchronously and an object store does not, and every caller
   * wants the same thing regardless.
   */
  async open(user: User, id: string) {
    const file = await this.findReachable(user, id);
    return { file, stream: await this.storage.read(file.storageKey) };
  }

  /**
   * Removes the row, then the bytes.
   *
   * That order because the row is what makes the file visible: once it is gone
   * the file is gone as far as anybody using the app is concerned, and a leftover
   * blob is a cleanup problem rather than a correctness one.
   */
  async remove(user: User, id: string): Promise<void> {
    const file = await this.findReachable(user, id);

    if (file.uploadedById !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only the person who uploaded this can remove it',
      );
    }

    await this.prisma.file.delete({ where: { id: file.id } });
    await this.storage.remove(file.storageKey);
  }

  /**
   * Refuses an upload that would take the school past what it may store.
   *
   * Summed from the rows rather than kept as a running total on the school: a
   * counter and the files it counts drift apart the first time a delete fails
   * halfway, and a wrong counter either locks a school out of its own storage or
   * stops enforcing anything. The sum is an indexed aggregate over one school's
   * files, which is cheap at the scale a tutoring school uploads at.
   *
   * Counted *before* the write and including the incoming file, so the limit is
   * a limit rather than something noticed one file too late.
   */
  private async assertWithinQuota(
    schoolId: string,
    incomingBytes: number,
  ): Promise<void> {
    const { _sum } = await this.prisma.file.aggregate({
      where: { schoolId },
      _sum: { sizeBytes: true },
    });

    const stored = _sum.sizeBytes ?? 0;
    if (stored + incomingBytes > this.maxSchoolBytes) {
      throw new PayloadTooLargeException(
        `Your school has used its ${Math.floor(this.maxSchoolBytes / MB)} MB of storage. Remove some files first.`,
      );
    }
  }

  private assertAcceptable(incoming: IncomingFile): void {
    if (incoming.size === 0) {
      throw new BadRequestException('That file is empty');
    }
    if (incoming.size > this.maxBytes) {
      throw new PayloadTooLargeException(
        `Files must be under ${Math.floor(this.maxBytes / MB)} MB`,
      );
    }
    if (!ALLOWED_MIME_TYPES.has(incoming.mimeType)) {
      throw new UnsupportedMediaTypeException(
        `Cannot store a ${incoming.mimeType} file`,
      );
    }
    // The list above trusts a header the client wrote. This does not: it reads
    // the first bytes and asks whether they are that type at all, which is what
    // stops a program or a web page being stored as somebody's worksheet.
    //
    // Same exception as an unaccepted type, and the same message: from the
    // outside "we do not store those" is the whole truth, and naming the check
    // only helps whoever is trying to get past it.
    if (!bytesLookLike(incoming.mimeType, incoming.buffer)) {
      throw new UnsupportedMediaTypeException(
        `Cannot store a ${incoming.mimeType} file`,
      );
    }
  }

  /**
   * Material attached to one lesson.
   *
   * Reachability is the lesson's, which `LessonsService` already decides — a tutor
   * reaches their own lessons and an admin the school's. One rule, one place,
   * exactly as a student's documents borrow `StudentsService.findOne`.
   */
  async listForLesson(user: User, lessonId: string): Promise<File[]> {
    const lesson = await this.lessons.findReachable(user, lessonId);

    return this.prisma.file.findMany({
      where: { lessonId: lesson.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Stores material against a lesson.
   *
   * Same write order as the other two: the row first, so a failed upload leaves
   * something findable rather than bytes nothing knows about.
   */
  async uploadForLesson(
    user: User,
    lessonId: string,
    incoming: IncomingFile,
  ): Promise<File> {
    const lesson = await this.lessons.findReachable(user, lessonId);
    this.assertAcceptable(incoming);
    await this.assertWithinQuota(lesson.schoolId, incoming.size);

    const row = await this.prisma.file.create({
      data: {
        storageKey: 'pending',
        originalName: incoming.originalName.slice(0, 255),
        mimeType: incoming.mimeType,
        sizeBytes: incoming.size,
        purpose: FilePurpose.LESSON_ATTACHMENT,
        schoolId: lesson.schoolId,
        uploadedById: user.id,
        lessonId: lesson.id,
      },
    });

    const storageKey = this.storage.keyFor(lesson.schoolId, row.id);
    await this.storage.save(storageKey, incoming.buffer);

    return this.prisma.file.update({
      where: { id: row.id },
      data: { storageKey, uploadedAt: new Date() },
    });
  }

  /**
   * A file this caller may see.
   *
   * Reachability is decided by the student it belongs to, which is the same
   * question `StudentsService` already answers — so a tutor reaches documents for
   * their own students and an admin the whole school, with no second rule to
   * keep in step.
   */
  private async findReachable(user: User, id: string): Promise<File> {
    const file = await this.prisma.file.findUnique({ where: { id } });

    if (!file || file.schoolId !== user.schoolId) {
      throw new NotFoundException('File not found');
    }
    if (file.studentId) {
      await this.students.findOne(user, file.studentId);
    }
    if (file.lessonId) {
      await this.lessons.findReachable(user, file.lessonId);
    }
    // A personal library belongs to the person. An admin can still reach one —
    // they are accountable for what is stored on the school's account — but a
    // colleague cannot, and a 404 keeps the id from being confirmed.
    if (
      file.purpose === FilePurpose.TUTOR_LIBRARY &&
      file.uploadedById !== user.id &&
      user.role !== 'ADMIN'
    ) {
      throw new NotFoundException('File not found');
    }

    return file;
  }
}
