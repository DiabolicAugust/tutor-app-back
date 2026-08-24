-- Signing out has to mean something.
--
-- A JWT is valid until it expires because nothing consults a database to check
-- it, which is the point of one -- and which is why revoking needs a value on
-- this side to compare against. Each token now carries the version it was issued
-- under; signing out bumps this, and every token issued before it stops working,
-- including the one on a phone that is no longer in its owner's hands.
--
-- A counter rather than a timestamp. `iat` has one-second resolution, so a
-- revocation *instant* cannot distinguish "issued just before the sign-out" from
-- "issued just after" -- and getting that wrong either resurrects the token the
-- sign-out was for, or refuses the session the user just created for its whole
-- life. A counter has no ambiguity and no dependence on a clock.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tokenVersion" INTEGER NOT NULL DEFAULT 0;
