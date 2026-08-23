import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { Note, User } from '../../generated/prisma/client';
import { LessonsService } from '../lessons/lessons.service';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';

/** What the app renders: the note, plus who wrote it. */
export type NoteWithAuthor = Note & { author: { id: string; name: string } };

const AUTHOR = { select: { id: true, name: true } } as const;

/**
 * Notes on a student, and notes on a single lesson.
 *
 * One service for both because they are one idea with two subjects. The
 * difference that matters is *whose* they are, and that question is already
 * answered elsewhere: a student note is reachable if the student is, a lesson
 * note if the lesson is. This class asks those two questions and does nothing
 * else with permissions.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
    private readonly lessons: LessonsService,
  ) {}

  /** Notes about the student in general, newest first. */
  async listForStudent(
    user: User,
    studentId: string,
  ): Promise<NoteWithAuthor[]> {
    // Throws unless this caller may see the student at all.
    const student = await this.students.findOne(user, studentId);

    return this.prisma.note.findMany({
      where: { studentId: student.id },
      orderBy: { createdAt: 'desc' },
      include: { author: AUTHOR },
    });
  }

  async addForStudent(
    user: User,
    studentId: string,
    text: string,
  ): Promise<NoteWithAuthor> {
    const student = await this.students.findOne(user, studentId);

    return this.prisma.note.create({
      data: { text: text.trim(), studentId: student.id, authorId: user.id },
      include: { author: AUTHOR },
    });
  }

  /** Notes about one lesson: what happened, what to do next time. */
  async listForLesson(user: User, lessonId: string): Promise<NoteWithAuthor[]> {
    const lesson = await this.lessons.findReachable(user, lessonId);

    return this.prisma.note.findMany({
      where: { lessonId: lesson.id },
      orderBy: { createdAt: 'desc' },
      include: { author: AUTHOR },
    });
  }

  async addForLesson(
    user: User,
    lessonId: string,
    text: string,
  ): Promise<NoteWithAuthor> {
    const lesson = await this.lessons.findReachable(user, lessonId);

    return this.prisma.note.create({
      data: { text: text.trim(), lessonId: lesson.id, authorId: user.id },
      include: { author: AUTHOR },
    });
  }

  /**
   * Removes a note.
   *
   * Only its author, or an admin. A tutor editing what a colleague wrote about a
   * shared student is a different feature with different expectations, and
   * silently allowing it is the wrong default.
   */
  async remove(user: User, id: string): Promise<void> {
    const note = await this.prisma.note.findUnique({ where: { id } });
    if (!note) throw new NotFoundException('Note not found');

    // Reachability first: proves the note belongs to this caller's school before
    // anything else is said about it.
    if (note.studentId) await this.students.findOne(user, note.studentId);
    if (note.lessonId) await this.lessons.findReachable(user, note.lessonId);

    if (note.authorId !== user.id && user.role !== 'ADMIN') {
      throw new ForbiddenException('Only the author can remove this note');
    }

    await this.prisma.note.delete({ where: { id: note.id } });
  }
}
