import type {
  Group,
  Lesson,
  Prisma,
  School,
  Student,
  Subject,
  User,
} from '../../generated/prisma/client';
import {
  AddonKey,
  AttendanceStatus,
  GradeKind,
  LessonStatus,
  UserRole,
} from '../../generated/prisma/enums';
import { AuthService } from '../../src/auth/auth.service';
import type { TestApp } from './test-app';

/** The password every factory-made account has, for the sign-in tests. */
export const TEST_PASSWORD = 'correct-horse-battery';

/**
 * Hashed once per process and reused.
 *
 * bcrypt at the production cost factor takes a few hundred milliseconds. Paying
 * that per created user would put most of the suite's runtime in a function
 * whose behaviour one test needs and the rest merely depend on.
 */
let cachedHash: string | undefined;
async function passwordHash(): Promise<string> {
  cachedHash ??= await AuthService.hashPassword(TEST_PASSWORD);
  return cachedHash;
}

/** Distinguishes rows across a file without depending on the clock. */
let counter = 0;
const unique = (prefix: string): string => `${prefix}-${++counter}`;

export async function makeSchool(
  { prisma }: TestApp,
  overrides: Partial<
    Pick<School, 'name' | 'slug' | 'timezone' | 'gradeScaleMax'>
  > = {},
): Promise<School> {
  const slug = overrides.slug ?? unique('school');

  return prisma.school.create({
    data: {
      name: overrides.name ?? `School ${slug}`,
      slug,
      timezone: overrides.timezone ?? 'Europe/Kyiv',
      ...(overrides.gradeScaleMax === undefined
        ? {}
        : { gradeScaleMax: overrides.gradeScaleMax }),
    },
  });
}

export async function makeUser(
  test: TestApp,
  options: {
    school: School;
    role?: UserRole;
    name?: string;
    email?: string;
    addons?: AddonKey[];
    config?: Prisma.InputJsonValue;
  },
): Promise<User> {
  const email = options.email ?? `${unique('user')}@example.test`;

  const user = await test.prisma.user.create({
    data: {
      email,
      name: options.name ?? email.split('@')[0],
      role: options.role ?? UserRole.TUTOR,
      passwordHash: await passwordHash(),
      schoolId: options.school.id,
      ...(options.config ? { config: options.config } : {}),
    },
  });

  if (options.addons?.length) {
    await test.prisma.userAddon.createMany({
      data: options.addons.map((addon) => ({ userId: user.id, addon })),
    });
  }

  return user;
}

/**
 * The school's subject with this name, created if it is not there yet.
 *
 * An upsert rather than a create, and that is the whole reason this exists: the
 * factories below default to one subject name, a school cannot hold that name
 * twice, and two students made without naming a subject have to end up studying
 * the same one rather than failing on the unique index.
 *
 * The factories still take a subject as a *name*, so every test that was written
 * against the free-text column reads the same. What changed is where the name
 * ends up.
 */
export function makeSubject(
  { prisma }: TestApp,
  options: { school: School; name?: string; hiddenAt?: Date | null },
): Promise<Subject> {
  return subjectNamed(prisma, options.school, options.name, options.hiddenAt);
}

async function subjectNamed(
  prisma: TestApp['prisma'],
  school: School,
  name = 'Maths',
  hiddenAt: Date | null = null,
): Promise<Subject> {
  try {
    return await prisma.subject.upsert({
      where: { schoolId_name: { schoolId: school.id, name } },
      update: { hiddenAt },
      create: { name, hiddenAt, schoolId: school.id },
    });
  } catch {
    // Two factories inside one `Promise.all` can ask for the same subject at the
    // same instant. The loser of that race wants the row the winner just made,
    // not a failed test about a unique index it was never checking.
    return prisma.subject.findFirstOrThrow({
      where: { schoolId: school.id, name },
    });
  }
}

export async function makeStudent(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    name?: string;
    /** A subject *name*; the row is made or reused as needed. */
    subject?: string;
    paidLessonsLeft?: number;
  },
): Promise<Student> {
  const subject = await subjectNamed(prisma, options.school, options.subject);

  return prisma.student.create({
    data: {
      name: options.name ?? unique('student'),
      subjectId: subject.id,
      paidLessonsLeft: options.paidLessonsLeft ?? 4,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
    },
  });
}

export async function makeLesson(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    student: Student;
    startsAt: Date;
    subject?: string;
    durationMinutes?: number;
    status?: LessonStatus;
    topic?: string;
    homework?: string;
  },
) {
  const subject = await subjectNamed(prisma, options.school, options.subject);

  return prisma.lesson.create({
    data: {
      subjectId: subject.id,
      startsAt: options.startsAt,
      durationMinutes: options.durationMinutes ?? 60,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
      studentId: options.student.id,
      ...(options.status ? { status: options.status } : {}),
      ...(options.topic ? { topic: options.topic } : {}),
      ...(options.homework ? { homework: options.homework } : {}),
    },
  });
}

/** A group, optionally with students already in it. */
export async function makeGroup(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    name?: string;
    subject?: string;
    level?: string;
    members?: Student[];
  },
): Promise<Group> {
  const subject = await subjectNamed(
    prisma,
    options.school,
    options.subject ?? 'English',
  );

  return prisma.group.create({
    data: {
      name: options.name ?? unique('group'),
      subjectId: subject.id,
      level: options.level ?? null,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
      members: options.members?.length
        ? {
            create: options.members.map((student) => ({
              studentId: student.id,
            })),
          }
        : undefined,
    },
  });
}

/** A lesson booked for a group rather than for one student. */
export async function makeGroupLesson(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    group: Group;
    startsAt: Date;
    subject?: string;
    durationMinutes?: number;
    status?: LessonStatus;
  },
) {
  const subject = await subjectNamed(
    prisma,
    options.school,
    options.subject ?? 'English',
  );

  return prisma.lesson.create({
    data: {
      subjectId: subject.id,
      startsAt: options.startsAt,
      durationMinutes: options.durationMinutes ?? 60,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
      groupId: options.group.id,
      ...(options.status ? { status: options.status } : {}),
    },
  });
}

/**
 * A lesson that has already been written up for one student.
 *
 * Since groups, attendance lives in its own table, so seeding a marked lesson is
 * two rows rather than a column — worth a factory precisely because getting it to
 * one call is what keeps the progress tests readable.
 */
export async function makeMarkedLesson(
  test: TestApp,
  options: {
    school: School;
    tutor: User;
    student: Student;
    startsAt: Date;
    attendance: AttendanceStatus;
    homeworkDone?: boolean;
    topic?: string;
    homework?: string;
  },
) {
  const lesson = await makeLesson(test, {
    ...options,
    // Deliberately derived rather than passed: a seeded lesson whose status
    // disagrees with its register is a state the API cannot produce, and a test
    // built on one proves nothing.
    status:
      options.attendance === AttendanceStatus.ABSENT_EXCUSED
        ? LessonStatus.CANCELLED
        : LessonStatus.COMPLETED,
  });

  await test.prisma.lessonAttendance.create({
    data: {
      lessonId: lesson.id,
      studentId: options.student.id,
      status: options.attendance,
      homeworkDone: options.homeworkDone ?? null,
    },
  });

  return lesson;
}

/**
 * A mark already in the book.
 *
 * Defaults to a classic grade so the common case reads as one line, and takes
 * `weight` explicitly because the weighted average is the thing most worth
 * testing and a default of 1 would hide it.
 */
export function makeGrade(
  { prisma }: TestApp,
  options: {
    student: Student;
    author: User;
    lesson?: Lesson;
    kind?: GradeKind;
    value?: number | null;
    weight?: number;
    category?: string;
    comment?: string;
  },
) {
  const kind = options.kind ?? GradeKind.CLASSIC;

  return prisma.grade.create({
    data: {
      kind,
      value:
        options.value === undefined
          ? kind === GradeKind.DESCRIPTIVE
            ? null
            : 10
          : options.value,
      weight: options.weight ?? 1,
      category: options.category ?? null,
      comment: options.comment ?? null,
      studentId: options.student.id,
      authorId: options.author.id,
      lessonId: options.lesson?.id ?? null,
    },
  });
}

/**
 * A real access token for a user, signed by the application's own JwtService.
 *
 * Issued directly rather than through the sign-in endpoint so the guards under
 * test see a genuine token without every test paying for a bcrypt comparison.
 * Sign-in itself is covered on its own.
 */
export async function tokenFor(test: TestApp, user: User): Promise<string> {
  const { token } = await test.app.get(AuthService).issueSession(user);
  return token;
}

/** `Authorization` header for a user, ready to hand to supertest. */
export async function authHeader(
  test: TestApp,
  user: User,
): Promise<{ Authorization: string }> {
  return { Authorization: `Bearer ${await tokenFor(test, user)}` };
}
