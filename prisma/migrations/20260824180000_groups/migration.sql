-- Groups, and attendance as a row per student per lesson.
--
-- The generated diff dropped `lessons.attendance` and `lessons.homeworkDone`
-- before creating `lesson_attendances`, which would have thrown away every
-- write-up. The statements below are deliberately reordered so the new table
-- exists and is populated *before* the old columns go.

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "level" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "schoolId" TEXT NOT NULL,
    "tutorId" TEXT NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "id" TEXT NOT NULL,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "groupId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lesson_attendances" (
    "id" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "homeworkDone" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lessonId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,

    CONSTRAINT "lesson_attendances_pkey" PRIMARY KEY ("id")
);

-- Carry every existing write-up across before the columns holding it are gone.
--
-- Only rows that actually recorded attendance: `status` is required in the new
-- shape, and a lesson whose homework was noted without anybody being marked
-- present has no status to carry. That combination was reachable in the old
-- shape and is not in this one, which is the point of the change.
INSERT INTO "lesson_attendances" ("id", "status", "homeworkDone", "createdAt", "updatedAt", "lessonId", "studentId")
SELECT
    gen_random_uuid()::text,
    "attendance",
    "homeworkDone",
    "updatedAt",
    "updatedAt",
    "id",
    "studentId"
FROM "lessons"
WHERE "attendance" IS NOT NULL AND "studentId" IS NOT NULL;

-- AlterTable
ALTER TABLE "lessons" DROP COLUMN "attendance",
DROP COLUMN "homeworkDone",
ADD COLUMN     "groupId" TEXT,
ALTER COLUMN "studentId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "groups_schoolId_idx" ON "groups"("schoolId");

-- CreateIndex
CREATE INDEX "groups_tutorId_idx" ON "groups"("tutorId");

-- CreateIndex
CREATE INDEX "group_members_studentId_idx" ON "group_members"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "group_members_groupId_studentId_key" ON "group_members"("groupId", "studentId");

-- CreateIndex
CREATE INDEX "lesson_attendances_studentId_idx" ON "lesson_attendances"("studentId");

-- CreateIndex
CREATE UNIQUE INDEX "lesson_attendances_lessonId_studentId_key" ON "lesson_attendances"("lessonId", "studentId");

-- CreateIndex
CREATE INDEX "lessons_groupId_startsAt_idx" ON "lessons"("groupId", "startsAt");

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_tutorId_fkey" FOREIGN KEY ("tutorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_attendances" ADD CONSTRAINT "lesson_attendances_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_attendances" ADD CONSTRAINT "lesson_attendances_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;
