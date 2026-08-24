-- Material can belong to a lesson.
--
-- `FilePurpose.LESSON_ATTACHMENT` already existed and had nowhere to point, so
-- attaching a worksheet to a lesson was not possible at all -- only to a student.
-- Against the lesson rather than the student because a group lesson hands the
-- same sheet to everybody, and copying it per student would store five files
-- where a person sees one.
--
-- Cascading on delete: a lesson that is gone has no material, and a row pointing
-- at a lesson that no longer exists is a file nothing can reach and nothing will
-- collect.

-- AlterTable
ALTER TABLE "files" ADD COLUMN     "lessonId" TEXT;

-- CreateIndex
CREATE INDEX "files_lessonId_idx" ON "files"("lessonId");

-- AddForeignKey
ALTER TABLE "files" ADD CONSTRAINT "files_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
