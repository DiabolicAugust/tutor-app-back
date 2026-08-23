import type {
  Prisma,
  School,
  Student,
  User,
} from '../../generated/prisma/client';
import { AddonKey, UserRole } from '../../generated/prisma/enums';
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
  overrides: Partial<Pick<School, 'name' | 'slug' | 'timezone'>> = {},
): Promise<School> {
  const slug = overrides.slug ?? unique('school');

  return prisma.school.create({
    data: {
      name: overrides.name ?? `School ${slug}`,
      slug,
      timezone: overrides.timezone ?? 'Europe/Kyiv',
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

export function makeStudent(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    name?: string;
    subject?: string;
    paidLessonsLeft?: number;
  },
): Promise<Student> {
  return prisma.student.create({
    data: {
      name: options.name ?? unique('student'),
      subject: options.subject ?? 'Maths',
      paidLessonsLeft: options.paidLessonsLeft ?? 4,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
    },
  });
}

export function makeLesson(
  { prisma }: TestApp,
  options: {
    school: School;
    tutor: User;
    student: Student;
    startsAt: Date;
    subject?: string;
    durationMinutes?: number;
  },
) {
  return prisma.lesson.create({
    data: {
      subject: options.subject ?? 'Maths',
      startsAt: options.startsAt,
      durationMinutes: options.durationMinutes ?? 60,
      schoolId: options.school.id,
      tutorId: options.tutor.id,
      studentId: options.student.id,
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
