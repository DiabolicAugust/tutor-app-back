-- A lesson can be held online, and remembers where.
--
-- Both columns are written when the lesson is booked and never rewritten. The
-- provider is stored beside the link rather than read back from the tutor's
-- settings on display: somebody who moves from Zoom to Meet in March must not
-- find February's lessons claiming to be on Meet, and a link already sent to a
-- student has to keep meaning what it meant when it was sent.
--
-- Both nullable, and null is the default: a lesson taught in a room is still the
-- ordinary case, and every lesson booked before this migration was one.

-- CreateEnum
CREATE TYPE "MeetingProvider" AS ENUM ('ZOOM', 'GOOGLE_MEET', 'JITSI');

-- AlterTable
ALTER TABLE "lessons" ADD COLUMN     "meetingProvider" "MeetingProvider",
ADD COLUMN     "meetingUrl" TEXT;
