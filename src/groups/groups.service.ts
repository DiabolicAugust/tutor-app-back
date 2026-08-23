import { Injectable, NotFoundException } from '@nestjs/common';

import type { User } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../students/students.service';
import type { CreateGroupDto, UpdateGroupDto } from './dto/group.dto';

/** The shape every group endpoint returns: the group plus who is in it. */
const WITH_MEMBERS = {
  members: {
    orderBy: { student: { name: 'asc' } },
    include: {
      student: {
        select: { id: true, name: true, subject: true, paidLessonsLeft: true },
      },
    },
  },
} as const;

/**
 * Groups of students taught together.
 *
 * Ownership follows the same rule as students, and deliberately so: a tutor
 * reaches their own groups, an admin the whole school. Anything else would mean
 * two answers to "whose is this" in one app.
 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  /** Groups the caller may see, members included — the roster screen's one call. */
  findVisible(user: User) {
    return this.prisma.group.findMany({
      where:
        user.role === 'ADMIN'
          ? { schoolId: user.schoolId }
          : { schoolId: user.schoolId, tutorId: user.id },
      orderBy: { name: 'asc' },
      include: WITH_MEMBERS,
    });
  }

  /**
   * The group, if this caller may touch it.
   *
   * Not-found rather than forbidden for another school's row, and for a
   * colleague's group too: a 403 would confirm the id exists.
   */
  async findOne(user: User, id: string) {
    const group = await this.prisma.group.findUnique({
      where: { id },
      include: WITH_MEMBERS,
    });

    if (!group || group.schoolId !== user.schoolId) {
      throw new NotFoundException('Group not found');
    }
    if (user.role !== 'ADMIN' && group.tutorId !== user.id) {
      throw new NotFoundException('Group not found');
    }

    return group;
  }

  create(user: User, dto: CreateGroupDto) {
    return this.prisma.group.create({
      data: {
        name: dto.name.trim(),
        subject: dto.subject.trim(),
        level: dto.level?.trim() || null,
        schoolId: user.schoolId,
        tutorId: user.id,
      },
      include: WITH_MEMBERS,
    });
  }

  async update(user: User, id: string, dto: UpdateGroupDto) {
    const group = await this.findOne(user, id);

    return this.prisma.group.update({
      where: { id: group.id },
      data: {
        name: dto.name?.trim(),
        subject: dto.subject?.trim(),
        // Distinguishes "not mentioned" from "cleared": only an explicitly sent
        // empty string blanks the level.
        ...(dto.level === undefined ? {} : { level: dto.level.trim() || null }),
      },
      include: WITH_MEMBERS,
    });
  }

  /**
   * Removes a group, and with it its lessons — the schema cascades.
   *
   * The students survive: they are their own records, and dissolving a group is
   * not the same as losing the people in it. Their marks and attendance survive
   * too, because those reference the student directly.
   */
  async remove(user: User, id: string) {
    const group = await this.findOne(user, id);
    await this.prisma.group.delete({ where: { id: group.id } });
  }

  /**
   * Puts a student in a group.
   *
   * Both halves are checked: `findOne` proves the group is the caller's, and
   * `students.findOne` proves the student is — otherwise a tutor could pull a
   * colleague's student into their own group and thereby see their history.
   *
   * Idempotent. Adding somebody who is already in is not an error worth showing
   * anybody, and the unique constraint would otherwise surface as a 409 for a
   * double tap.
   */
  async addMember(user: User, groupId: string, studentId: string) {
    const group = await this.findOne(user, groupId);
    const student = await this.students.findOne(user, studentId);

    await this.prisma.groupMember.upsert({
      where: {
        groupId_studentId: { groupId: group.id, studentId: student.id },
      },
      create: { groupId: group.id, studentId: student.id },
      update: {},
    });

    return this.findOne(user, group.id);
  }

  /**
   * Takes a student out of a group.
   *
   * Their attendance and marks stay: those reference the lesson and the student
   * directly, which is exactly why membership needs no end date to be honest
   * about history.
   */
  async removeMember(user: User, groupId: string, studentId: string) {
    const group = await this.findOne(user, groupId);

    await this.prisma.groupMember.deleteMany({
      where: { groupId: group.id, studentId },
    });

    return this.findOne(user, group.id);
  }
}
