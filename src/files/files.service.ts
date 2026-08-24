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
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
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

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly students: StudentsService,
    config: ConfigService<Env, true>,
  ) {
    this.maxBytes = config.get('MAX_UPLOAD_MB', { infer: true }) * MB;
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
