-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'ABSENT_EXCUSED', 'ABSENT_UNEXCUSED');

-- CreateEnum
CREATE TYPE "GradeKind" AS ENUM ('CLASSIC', 'PERCENTAGE', 'DESCRIPTIVE');

-- AlterTable
ALTER TABLE "lessons" ADD COLUMN     "attendance" "AttendanceStatus",
ADD COLUMN     "homework" TEXT,
ADD COLUMN     "topic" TEXT;

-- AlterTable
ALTER TABLE "schools" ADD COLUMN     "gradeScaleMax" INTEGER NOT NULL DEFAULT 12;

-- CreateTable
CREATE TABLE "grades" (
    "id" TEXT NOT NULL,
    "kind" "GradeKind" NOT NULL,
    "value" DOUBLE PRECISION,
    "category" TEXT,
    "comment" TEXT,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "grades_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "grades_studentId_createdAt_idx" ON "grades"("studentId", "createdAt");

-- CreateIndex
CREATE INDEX "grades_lessonId_idx" ON "grades"("lessonId");

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "grades" ADD CONSTRAINT "grades_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

