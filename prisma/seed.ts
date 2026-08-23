import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import * as bcrypt from 'bcrypt';

import { PrismaClient } from '../generated/prisma/client';
import { AddonKey, LessonStatus, NotificationKind, UserRole } from '../generated/prisma/enums';

/**
 * Development seed.
 *
 * Deliberately the same cast as the mobile app's fixtures, so a device pointed
 * at a seeded backend shows what it showed on fixtures — same names, same
 * balances, same announcement. Times are generated relative to *now* for the
 * same reason they are in the app: a lesson that has already ended unconfirmed
 * and one starting within the hour must exist whenever the seed is run, or the
 * notification flows have nothing to demonstrate.
 *
 * Idempotent: re-running replaces the demo school rather than duplicating it.
 */
const DEMO_SCHOOL_ID = 'demo-school';
const TUTOR_PASSWORD = 'password123';

function hoursFromNow(hours: number, minuteOffset = 0): Date {
  const date = new Date();
  date.setMinutes(0, 0, 0);
  return new Date(date.getTime() + (hours * 60 + minuteOffset) * 60 * 1000);
}

function onDay(dayOffset: number, hour: number, minute = 0): Date {
  const date = new Date();
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return date;
}

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  const prisma = new PrismaClient({ adapter });

  // Cascades clear users, students, lessons and notifications with it.
  await prisma.school.deleteMany({ where: { id: DEMO_SCHOOL_ID } });

  const passwordHash = await bcrypt.hash(TUTOR_PASSWORD, 12);

  const school = await prisma.school.create({
    data: {
      id: DEMO_SCHOOL_ID,
      name: 'Fox Academy Demo',
      slug: 'fox-academy-demo',
      timezone: 'Europe/Kyiv',
    },
  });

  // One admin and three tutors, so both roles are reachable in a demo.
  const [admin, anna, olena, taras] = await Promise.all([
    prisma.user.create({
      data: {
        email: 'admin@school.com',
        name: 'School Admin',
        role: UserRole.ADMIN,
        passwordHash,
        schoolId: school.id,
      },
    }),
    prisma.user.create({
      data: {
        email: 'anna.koval@school.com',
        name: 'Anna Koval',
        role: UserRole.TUTOR,
        passwordHash,
        schoolId: school.id,
      },
    }),
    prisma.user.create({
      data: {
        email: 'olena.hrytsenko@school.com',
        name: 'Olena Hrytsenko',
        role: UserRole.TUTOR,
        passwordHash,
        schoolId: school.id,
      },
    }),
    prisma.user.create({
      data: {
        email: 'taras.lysenko@school.com',
        name: 'Taras Lysenko',
        role: UserRole.TUTOR,
        passwordHash,
        schoolId: school.id,
      },
    }),
  ]);

  const students = await Promise.all(
    [
      { name: 'Petro Melnyk', subject: 'Algebra', paidLessonsLeft: 1, tutorId: anna.id },
      { name: 'Sofia Bondar', subject: 'Geometry', paidLessonsLeft: 8, tutorId: anna.id },
      { name: 'Maksym Zhuk', subject: 'Mathematics', paidLessonsLeft: 5, tutorId: anna.id },
      { name: 'Ivan Shevchenko', subject: 'Mathematics', paidLessonsLeft: 12, tutorId: anna.id },
      { name: 'Mariia Tkachenko', subject: 'Mathematics', paidLessonsLeft: 4, tutorId: anna.id },
      { name: 'Daria Sydorenko', subject: 'English', paidLessonsLeft: 3, tutorId: olena.id },
      { name: 'Ihor Palii', subject: 'Physics', paidLessonsLeft: 9, tutorId: taras.id },
    ].map((student) =>
      prisma.student.create({ data: { ...student, schoolId: school.id } }),
    ),
  );

  const byName = (name: string) => students.find((student) => student.name === name)!;

  await prisma.lesson.createMany({
    data: [
      // Already ended and still scheduled: the app turns this into a
      // "did this take place?" notification.
      {
        subject: 'Algebra',
        startsAt: hoursFromNow(-1, -30),
        durationMinutes: 45,
        tutorId: anna.id,
        studentId: byName('Petro Melnyk').id,
        schoolId: school.id,
      },
      // Within the hour: becomes "starting soon".
      {
        subject: 'Geometry',
        startsAt: hoursFromNow(1),
        durationMinutes: 90,
        tutorId: anna.id,
        studentId: byName('Sofia Bondar').id,
        schoolId: school.id,
      },
      // Same slot on a colleague's calendar: exercises overlap columns and filters.
      {
        subject: 'English',
        startsAt: hoursFromNow(1),
        durationMinutes: 60,
        tutorId: olena.id,
        studentId: byName('Daria Sydorenko').id,
        schoolId: school.id,
      },
      {
        subject: 'Mathematics',
        startsAt: hoursFromNow(7),
        durationMinutes: 60,
        status: LessonStatus.CANCELLED,
        tutorId: anna.id,
        studentId: byName('Maksym Zhuk').id,
        schoolId: school.id,
      },
      {
        subject: 'Mathematics',
        startsAt: onDay(-1, 13),
        durationMinutes: 60,
        status: LessonStatus.COMPLETED,
        tutorId: anna.id,
        studentId: byName('Mariia Tkachenko').id,
        schoolId: school.id,
      },
      {
        subject: 'Mathematics',
        startsAt: onDay(1, 9, 30),
        durationMinutes: 60,
        tutorId: anna.id,
        studentId: byName('Ivan Shevchenko').id,
        schoolId: school.id,
      },
      {
        subject: 'Physics',
        startsAt: onDay(2, 17),
        durationMinutes: 90,
        tutorId: taras.id,
        studentId: byName('Ihor Palii').id,
        schoolId: school.id,
      },
    ],
  });

  // Reminders on for one tutor, so a test build shows the preference in use
  // rather than every account sitting on defaults.
  await prisma.user.update({
    where: { id: anna.id },
    data: { config: { lessonReminders: true, lessonReminderMinutes: 60 } },
  });

  // One tutor gets the invite capability, so a test build shows a member who can
  // invite without being an admin — the whole point of addons.
  await prisma.userAddon.createMany({
    data: [
      { userId: anna.id, addon: AddonKey.INVITE_TUTORS, enabledById: admin.id },
      { userId: anna.id, addon: AddonKey.MANAGE_STUDENTS, enabledById: admin.id },
      // Olena manages students but cannot invite, so a test build shows two
      // members with genuinely different capabilities.
      { userId: olena.id, addon: AddonKey.MANAGE_STUDENTS, enabledById: admin.id },
    ],
  });

  await prisma.notification.createMany({
    data: [
      {
        kind: NotificationKind.ADMIN_ANNOUNCEMENT,
        data: { text: 'Parent-teacher meetings move to Friday. Please keep 15:00-18:00 free.' },
        recipientId: anna.id,
      },
      {
        kind: NotificationKind.PAYMENT_RUNNING_OUT,
        data: { studentName: 'Petro Melnyk', count: 1 },
        recipientId: anna.id,
      },
      {
        kind: NotificationKind.TUTOR_JOINED,
        data: { personName: 'Taras Lysenko', text: 'Physics' },
        recipientId: anna.id,
      },
    ],
  });

  console.log(`Seeded ${DEMO_SCHOOL_ID}. Password for every account: ${TUTOR_PASSWORD}`);
  console.log(`  tutor: ${anna.email}`);
  console.log(`  admin: ${admin.email}`);
  console.log(`  ${anna.email} holds INVITE_TUTORS + MANAGE_STUDENTS`);
  console.log(`  ${olena.email} holds MANAGE_STUDENTS only`);

  await prisma.$disconnect();
}

void main();
