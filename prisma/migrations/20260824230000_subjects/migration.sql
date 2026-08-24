-- Subjects become rows.
--
-- `students.subject`, `groups.subject` and `lessons.subject` were three
-- unrelated strings. The same subject arrived spelled several ways, nothing
-- could be asked of it, and there was no answer to "what does this school
-- teach". This creates the table, collects what is already written into it,
-- repoints the three relations, and drops the strings.
--
-- The backfill is SQL rather than a script run alongside, because every
-- environment gets its schema through `prisma migrate deploy` and nothing else.
-- A separate script would have to be remembered on each one, and would be
-- forgotten exactly once.

-- CreateTable
CREATE TABLE "subjects" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hiddenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "schoolId" TEXT NOT NULL,

    CONSTRAINT "subjects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "subjects_schoolId_idx" ON "subjects"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "subjects_schoolId_name_key" ON "subjects"("schoolId", "name");

-- AddForeignKey
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "schools"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable: the new columns, added while the old ones are still readable.
ALTER TABLE "students" ADD COLUMN     "subjectId" TEXT;
ALTER TABLE "groups" ADD COLUMN     "subjectId" TEXT;
ALTER TABLE "lessons" ADD COLUMN     "subjectId" TEXT;

-- Collect every subject each school already mentions, wherever it mentions it,
-- as one row per distinct name. `UNION` rather than `UNION ALL`: a name that
-- appears on a student, their group and their lessons is one subject.
--
-- The id is derived from the school and the name instead of generated. That
-- makes the repointing below an assignment rather than a join, and makes this
-- migration produce identical ids every time it is run against the same data —
-- which is what allowed it to be tested on a copy of the real database.
INSERT INTO "subjects" ("id", "name", "schoolId", "createdAt", "updatedAt")
SELECT md5("schoolId" || ':' || "name"),
       "name",
       "schoolId",
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM (
    SELECT "schoolId", btrim("subject") AS "name" FROM "students"
    UNION
    SELECT "schoolId", btrim("subject") AS "name" FROM "groups"
    UNION
    SELECT "schoolId", btrim("subject") AS "name" FROM "lessons"
) AS "collected"
WHERE "name" <> '';

-- Repoint each row at the subject it named.
--
-- A blank stays blank, as NULL. Nothing is invented for it: the app already
-- accepted a student with no subject and a lesson with none typed in, and
-- inventing a name to satisfy a foreign key would put data in the database that
-- nobody ever entered.
UPDATE "students" SET "subjectId" = md5("schoolId" || ':' || btrim("subject")) WHERE btrim("subject") <> '';
UPDATE "groups" SET "subjectId" = md5("schoolId" || ':' || btrim("subject")) WHERE btrim("subject") <> '';
UPDATE "lessons" SET "subjectId" = md5("schoolId" || ':' || btrim("subject")) WHERE btrim("subject") <> '';

-- CreateIndex
CREATE INDEX "students_subjectId_idx" ON "students"("subjectId");

-- CreateIndex
CREATE INDEX "groups_subjectId_idx" ON "groups"("subjectId");

-- CreateIndex
CREATE INDEX "lessons_subjectId_idx" ON "lessons"("subjectId");

-- AddForeignKey
ALTER TABLE "students" ADD CONSTRAINT "students_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "groups" ADD CONSTRAINT "groups_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "subjects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The strings are gone only now, after everything that read them has run.
ALTER TABLE "students" DROP COLUMN "subject";
ALTER TABLE "groups" DROP COLUMN "subject";
ALTER TABLE "lessons" DROP COLUMN "subject";
