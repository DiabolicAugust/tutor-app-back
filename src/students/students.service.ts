import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SubjectsService } from '../subjects/subjects.service';
import type { CreateStudentDto } from './dto/create-student.dto';
import type { UpdateStudentDto } from './dto/update-student.dto';

/**
 * The subject comes back as the row rather than a name, because the app needs
 * both halves: the name to show, and the id to preselect in the picker when the
 * student is edited. `hiddenAt` travels with it so a form can keep offering a
 * retired subject to the one student who still studies it.
 */
const WITH_SUBJECT = {
  subject: { select: { id: true, name: true, hiddenAt: true } },
} as const;

@Injectable()
export class StudentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly subjects: SubjectsService,
  ) {}

  /**
   * The students a tutor may book for.
   *
   * A school admin sees the whole school; a tutor sees only their own. The app's
   * booking form calls exactly this, which is why the filtering lives here and
   * not in the client.
   */
  findVisible(user: User) {
    return this.prisma.student.findMany({
      where:
        user.role === 'ADMIN'
          ? { schoolId: user.schoolId }
          : { schoolId: user.schoolId, tutorId: user.id },
      orderBy: { name: 'asc' },
      include: WITH_SUBJECT,
    });
  }

  async findOne(user: User, id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      include: WITH_SUBJECT,
    });

    // Not-found rather than forbidden for another school's row: a 403 would
    // confirm the id exists.
    if (!student || student.schoolId !== user.schoolId) {
      throw new NotFoundException('Student not found');
    }
    if (user.role !== 'ADMIN' && student.tutorId !== user.id) {
      throw new ForbiddenException('Not your student');
    }

    return student;
  }

  /**
   * Edits a student.
   *
   * Ownership is enforced by `findOne`, which is the single place that decides
   * who may touch which row — a tutor their own, an admin the whole school. The
   * capability to edit at all is checked on the controller.
   */
  async update(user: User, id: string, dto: UpdateStudentDto) {
    const student = await this.findOne(user, id);

    return this.prisma.student.update({
      where: { id: student.id },
      data: {
        name: dto.name?.trim(),
        // Three cases, and they are all real: absent leaves the subject alone,
        // null clears it, and an id moves the student. `student.subjectId` is
        // passed as the current value so an edit to the name alone is not
        // refused for a subject the school has since retired.
        ...(dto.subjectId === undefined
          ? {}
          : {
              subjectId: await this.subjects.resolve(
                user,
                dto.subjectId,
                student.subjectId,
              ),
            }),
        paidLessonsLeft: dto.paidLessonsLeft,
      },
      include: WITH_SUBJECT,
    });
  }

  /**
   * Removes a student, and with them their lessons — the schema cascades.
   *
   * That is the honest behaviour for a mistaken entry. Once a student has real
   * history worth keeping, this wants to become an archive flag instead; the
   * cascade is what makes that change visible rather than silent.
   */
  async remove(user: User, id: string) {
    const student = await this.findOne(user, id);
    await this.prisma.student.delete({ where: { id: student.id } });
  }

  async create(user: User, dto: CreateStudentDto) {
    return this.prisma.student.create({
      data: {
        name: dto.name.trim(),
        subjectId: await this.subjects.resolve(user, dto.subjectId ?? null),
        paidLessonsLeft: dto.paidLessonsLeft ?? 0,
        schoolId: user.schoolId,
        tutorId: user.id,
      },
      include: WITH_SUBJECT,
    });
  }
}
