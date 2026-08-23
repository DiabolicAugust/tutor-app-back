# tutor-app-back

Backend for Fox Academy — a SaaS for private tutors and tutoring schools. Serves the
Expo/React Native client that lives in `../../ReactNative/foxacademy`.

NestJS 11, Prisma 7, PostgreSQL. **Early scaffold**: school onboarding, auth, students,
lessons and notifications exist; the schema is complete for what the app currently renders.

Multi-tenant from the start: every row belongs to a `School`, and a user is either an
**admin** (runs the school) or a **tutor** (teaches).

## Getting started

```bash
npm install
cp .env.example .env        # then set DATABASE_URL and JWT_SECRET

# A throwaway database, if you do not have one:
docker run --name fox-db -e POSTGRES_PASSWORD=fox -p 5432:5432 -d postgres:17

npm run db:deploy           # applies the migrations in prisma/migrations
npm run db:seed             # demo school, tutors, students, lessons, notifications
npm run start:dev
```

The API is served under `/api`. Health check: `GET /api/health` — it runs a real query,
so a process that is up but cannot reach Postgres reports unhealthy rather than 200.

After seeding, sign in as `anna.koval@school.com` (tutor) or `admin@school.com` (admin);
the password for both is `password123`.

| Command | What it does |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | Compile to `dist/` |
| `npm run db:migrate` | Create/apply a migration in development |
| `npm run db:deploy` | Apply pending migrations (CI, production) |
| `npm run db:seed` | Reset and reseed the demo school |
| `npm run db:studio` | Prisma Studio |
| `npm run test:all` | Unit tests, then the integration suite |
| `npm run db:test:up` | Throwaway Postgres for the tests, on port 55432 |

## Migrations

`prisma/migrations` holds the schema's history, starting with `20260823000000_init`. Apply
them with `npm run db:deploy`; author a new one with `npm run db:migrate` after editing
`schema.prisma`.

The integration suite applies them too, rather than pushing the schema directly, so every
test run is also a test that the migrations apply cleanly to an empty database — the
alternative leaves them unexercised until a deploy, which is the worst moment to discover
one of them does not apply.

That means a test database created before the migrations existed has the tables but no
migration history, and the suite will refuse it. `npm run db:test:down && npm run db:test:up`
starts a clean one.

## Prisma 7 notes

This is Prisma **7**, which differs from every tutorial written for 5 or 6:

- **A driver adapter is mandatory.** `new PrismaClient()` with no adapter throws.
  `PrismaService` passes `PrismaPg` with the validated `DATABASE_URL`.
- **The client is generated into `generated/prisma`**, not `node_modules`. Import model
  types from `generated/prisma/client` and enums from `generated/prisma/enums`. The folder
  is gitignored — run `npm run db:generate` after cloning.
- **The datasource URL lives in `prisma.config.ts`**, not in `schema.prisma`, and that
  file loads `.env` itself.
- **The generator emits ESM unless told otherwise**, and this project compiles to
  CommonJS. Without `moduleFormat = "cjs"` the emitted client carries `import.meta`, which
  makes Node treat the compiled file as a module and die on `exports is not defined` before
  the server finishes starting — so the whole API was unbootable until the tests were
  written. `importFileExtension = ""` goes with it: the default `.js` suffixes are an ESM
  requirement only TypeScript's own resolver understands, and every other tool reading
  those files looks for a `.js` that was never emitted.

## Tests

Two suites, run by `npm run test:all`:

- **`npm test`** — unit tests beside the code they cover (`src/**/*.spec.ts`): config
  validation, the user-config parser, the guards, the mail transport. No database, so they
  run in about a second.
- **`npm run test:e2e`** — the whole application over HTTP against a real Postgres
  (`test/*.e2e-spec.ts`), through the same guards, validation pipe and exception filter
  production uses. `src/app-setup.ts` exists so both boot the identical app: a suite that
  skipped the global prefix or the validation pipe would be exercising software that does
  not ship.

**Against a real database on purpose.** Most of what this backend enforces *is* a `where`
clause — tenant isolation, student ownership, the capability join — and a mocked Prisma
would confirm the wrong query as readily as the right one. These tests would have caught
every bug they were written after.

Getting a database:

```bash
npm run db:test:up      # throwaway Postgres on port 55432
npm run test:e2e        # applies the migrations, then runs
npm run db:test:down
```

`TEST_DATABASE_URL` overrides the connection. Note that the suite **overwrites**
`DATABASE_URL` rather than inheriting it, and refuses any database whose name does not
contain "test" — these tests truncate every table between cases, and inheriting a
developer's URL would mean one `npm test` wiping the database they were working in.

Two details worth knowing before they cost an hour:

- Jest runs through `node --experimental-vm-modules`, because Prisma 7's client loads its
  query compiler through a real dynamic `import()` that Jest's CommonJS VM cannot execute
  otherwise.
- The e2e suite runs single-threaded. It shares one database and truncates between tests,
  so parallel workers would delete each other's rows.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request against it:
generate the client, typecheck, lint, build, then both test suites, with Postgres as a
service container. `lint:ci` exists because `lint` fixes in place — a CI job that passes by
rewriting the code under review is not a check.

## Architecture

```
src/
  main.ts                  # bootstrap: /api prefix, global validation, CORS, shutdown hooks
  app.module.ts            # composition root
  config/                  # env schema (zod) + global ConfigModule
  prisma/                  # PrismaService (global) — the only place the DB is touched
  common/                  # cross-cutting: @CurrentUser, Prisma error → HTTP filter
  auth/                    # sign-in, JWT strategy, guard
  schools/                 # onboarding, school settings, the tutor roster
  students/
  lessons/
  notifications/
prisma/
  schema.prisma            # the domain
  seed.ts                  # demo data mirroring the app's fixtures
```

**A feature module owns its data.** There is no shared repository layer: when a feature
needs another's data it calls that module's service. `LessonsModule` imports
`StudentsModule` and books through `students.findOne()`, which is also what proves the
student belongs to the caller. One authorisation rule, one place.

**Tenant isolation is a `where` clause, not a convention.** Every row carries `schoolId`,
and every query filters on it first. Rows from another school return **404, not 403** — a
403 would confirm the id exists.

**Two roles, and they answer different questions.** `ADMIN` runs the school, `TUTOR`
teaches. Students are records a tutor owns, not accounts, so they are deliberately not a
role. Who *may call* an endpoint is declared on the handler with `@Roles(UserRole.ADMIN)`
plus `RolesGuard` — a permission model scattered as `if (user.role !== …) throw` inside
services is one you have to read the whole codebase to know. What a caller *may see* stays
in the services, because an admin and a tutor may both call `GET /lessons` and correctly
get different rows.

**A school is created with its first admin, in one transaction.** A school with no admin
is a tenant nobody can enter, and it would hold the slug forever. Registration returns a
session, so onboarding does not end on a login form.

**Environment is validated at boot.** `config/env.ts` parses `process.env` with zod and
throws on a bad value, so a missing `JWT_SECRET` stops the process on startup instead of
surfacing as a 500 the first time someone signs in.

**Validation is global and strict.** `whitelist` strips undeclared properties and
`forbidNonWhitelisted` rejects them, so a client cannot smuggle fields past a DTO.

## Matching the app

Field names deliberately match the client's types, so its `AuthClient` implementation is a
fetch and a cast rather than a mapping layer:

- `POST /api/auth/sign-in` returns `{ user, token, issuedAt }` — the app's `Session`
  exactly, with `role` as `tutor | school-admin | student`.
- `GET /api/lessons?from=&to=&tutorIds=` — one call per calendar view. A window is
  required, not optional: the calendar only ever renders a day, three days or a month.
- `PATCH /api/lessons/:id/status` — what the news feed calls when the tutor answers "did
  this take place?". Marking a lesson completed spends one from the student's package **in
  the same transaction**; a balance that drifts from the schedule is worse than no balance.
- `GET /api/students` returns only what the caller may book for, which is why the app's
  picker needs no filtering of its own.
- `GET /api/schools/current/tutors` is the calendar's filter list, with the caller first so
  "my calendar" is always the top row. This replaces the app's `fixtureColleagues`.

### Endpoints

| Method | Path | Who |
| --- | --- | --- |
| POST | `/api/schools/register` | public — creates a school and its first admin |
| POST | `/api/auth/sign-in` | public |
| GET | `/api/auth/me` | any member |
| GET | `/api/schools/current` | any member |
| PATCH | `/api/schools/current` | admin |
| GET | `/api/schools/current/tutors` | any member |
| POST | `/api/schools/current/tutors` | admin |
| GET · POST | `/api/students` | any member (scoped to own students unless admin) |
| GET `/api/students/:id` | | owner or admin |
| GET · POST | `/api/lessons` | any member |
| PATCH | `/api/lessons/:id/status` | owner or admin |
| POST | `/api/invitations` | admin — invites a tutor by email |
| GET | `/api/invitations` | admin |
| DELETE | `/api/invitations/:id` | admin |
| GET | `/api/invitations/token/:token` | public — what the app shows on the form |
| POST | `/api/invitations/token/:token/accept` | public — creates the account, returns a session |
| GET | `/api/notifications` | recipient |
| POST | `/api/notifications/:id/read`, `/read-all` | recipient |

**Lesson reminders are not stored here.** The app derives "did this take place?" and
"starting soon" from the schedule it already has. A derived reminder cannot go stale; a
stored one would need retracting the moment the lesson is confirmed. Only genuinely
server-authored kinds live in the `notifications` table — announcements, a new colleague,
a payment running low.

## Invitations

An admin invites a tutor by email. The backend stores an `Invitation` row — a revocable,
listable, single-use record rather than a signed stateless token — and mails a link of the
form `foxacademy://invite/<token>`, which opens the mobile app straight on its registration
form. The invited address comes from the row, never from the client, or the link would be a
way to create an account for any address.

Re-inviting the same address **replaces** the invitation with a fresh token and clock: an
admin resending because the first mail was lost expects that to work.

Accepting marks the row used and creates the user in one transaction, so two simultaneous
taps cannot redeem one link twice. Missing, expired and already-used links all return the
same message — distinguishing them tells a stranger things about the school.

`MailService` is a seam, not an implementation. With `MAIL_TRANSPORT=log` (the default and
currently the only value) the message — including the link — is written to the server log,
which makes the flow testable with no provider account. A misconfigured transport throws
rather than silently dropping mail.

## Files

Every uploaded file gets a row in `files`, always. Storage holds bytes and nothing else: it
cannot say who uploaded something, which school it belongs to, or whether anything still
references it. The row is the record of truth and `storageKey` is the only thing the
storage backend knows about.

Two consequences worth keeping:

- `uploadedAt` is null until an upload is confirmed, so an interrupted upload leaves a
  collectable row instead of an object nobody knows exists.
- `User.avatarFileId` and `School.logoFileId` are real foreign keys with `SetNull`, so
  deleting a file that is still referenced is a database error rather than a broken image.

`purpose` (`AVATAR`, `SCHOOL_LOGO`, `LESSON_ATTACHMENT`, `OTHER`) is what will drive size
limits and retention, and stops a lesson attachment being served as somebody's avatar.
**Upload endpoints are not built yet** — this is the schema they will write into.

## Seed data

`prisma/seed.ts` creates the same cast as the app's fixtures — same names, same balances,
same announcement — and generates times **relative to now**: a lesson that has already
ended unconfirmed, one starting within the hour, two in the same slot on different
calendars. That is deliberate. It guarantees every notification kind and calendar state is
reachable whenever the seed runs, rather than only on the day the data was written. Keep it
that way when adding features.

Re-running the seed deletes and recreates the demo school, so it is safe to repeat.

## Not done yet

- **A user belongs to exactly one school.** A tutor working at two would need a membership
  join table — deliberately deferred until someone actually asks for it, since it changes
  every query.
- **Refresh tokens.** Access tokens last 7 days and there is no rotation or revocation.
- **Notification creation.** The table and read endpoints exist; nothing writes to it
  outside the seed. Payment reminders want a scheduled job.
- **Rate limiting** on sign-in, and structured request logging.
