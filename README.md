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

## Standing up to abuse

Anybody who installs the app can read the API address out of it and send whatever they
like. So the assumption here is a hostile client that holds a valid token, and the
question is what it can cost us.

**Rate limits are global and count the caller, not the address.** `ThrottlerByCallerGuard`
is registered as an `APP_GUARD`, so a route added tomorrow is limited without anybody
remembering to say so — the opposite way round from the authentication guard, and
deliberately: a missing auth guard is noticed by the first person who tries the route
without a token, while a missing rate limit is noticed by nobody until it is used.

Requests with a valid token are counted per **account**, everything else per **address**.
A tutoring school is several people on one office connection, and counting them together
means the fifth to arrive finds the allowance spent. The guard verifies the token itself
rather than reading `request.user`, because global guards run before the per-controller
`JwtAuthGuard` and `request.user` is empty at that point — and it *verifies* rather than
decodes, because an unverified `sub` is a value the caller picks, which would let a client
mint itself a fresh allowance per request.

Two windows apply at once, a minute and an hour: one alone either permits a slow grind or
a damaging burst. `common/throttling.ts` holds the numbers, and the tightest belong to
signing in — every attempt spends a bcrypt comparison at cost factor 12, about a quarter
of a second of processor time, which is what makes a few hundred requests a second enough
to stop the server answering anybody.

**Uploads are bounded three ways, because each bound misses what the others catch.**
Multer enforces the per-file size while reading, so the bytes never reach memory — the
service also checks it, but only after the whole body has been buffered, which stopped
large files from being *stored* and did nothing to stop them being *received*. A per-school
quota bounds the total, so an ordinary account cannot fill the disk one allowed file at a
time. And a rate limit bounds the count, which neither of the other two does.

**A declared content type is not evidence.** `files/file-signatures.ts` reads the first
bytes and asks whether they are the type the client claimed. The allow-list reads a header
the client wrote; this is the half that looks at the file, and it is what keeps a store of
programs and web pages from accumulating inside a school's documents.

**Windows and lists are capped.** `GET /lessons` always required a date window, which is
not the same as bounding one: nothing stopped a client asking for 1970 to 2100 and
receiving every lesson a school ever had with each group's full membership attached. The
window is capped at 400 days and the calendar-filter list at 50.

**Bodies, headers and origins.** JSON is capped at 64 kB — uploads are multipart and
bounded separately. `helmet` sets the response headers. `trust proxy` is one hop, not
`true`: `true` would take the leftmost `X-Forwarded-For` value, which the client writes,
so a caller could claim a new address per request and have no limit at all. `CORS_ORIGINS`
of `*` is refused at boot in production.

**What the tests cover.** `test/throttling.e2e-spec.ts` builds its own module, because the
application skips throttling under `NODE_ENV=test` — the rest of the suite signs in
hundreds of times in half a minute. It proves the parts this repository wrote: that two
accounts behind one address have separate allowances, and that invented tokens do not each
get one. The upload signature check, the storage quota and the window cap are covered in
`files.e2e-spec.ts` and `lessons.e2e-spec.ts`.

**Known and deliberate.** `GET /lessons?tutorIds=` lets any member of a school read a
colleague's calendar, and with it the names of that colleague's students — which the
roster endpoint hides from a non-admin tutor. That is the calendar-filters feature working
as built, not a leak across schools, but the two endpoints disagree about who may see whom
and that is worth a decision rather than a discovery.

**Not done.** Signing out is client-side only: a token stays valid until it expires, so a
stolen one is good for as long as `JWT_EXPIRES_IN` says. Making sign-out revoke needs
something server-side to revoke against — a `sessionsValidFrom` column on the user is the
cheap version, and rejecting tokens issued before it in `JwtStrategy` is the whole change.

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
| POST · DELETE | `/api/users/me/devices` | caller — registers or forgets a push token |
| GET | `/api/students/:id/lessons` | owner or admin — history, newest first |
| GET · POST | `/api/students/:id/notes` | owner or admin |
| GET · POST | `/api/lessons/:id/notes` | owner or admin |
| DELETE | `/api/notes/:id` | author or admin |
| GET · POST | `/api/students/:id/files` | owner or admin (POST is multipart, field `file`) |
| GET | `/api/files/:id` | owner or admin — streamed as an attachment |
| DELETE | `/api/files/:id` | uploader or admin |

**Lesson reminders are not stored here.** The app derives "did this take place?" and
"starting soon" from the schedule it already has. A derived reminder cannot go stale; a
stored one would need retracting the moment the lesson is confirmed. Only genuinely
server-authored kinds live in the `notifications` table — announcements, a new colleague,
a payment running low.

### Notes

Notes are one table for two subjects: a note about a student in general, and a note about
one lesson. `Note` carries `studentId` **or** `lessonId`, never both — Prisma cannot express
that, so `NotesService` enforces it. Two near-identical tables would have meant two
endpoints, two clients and two components for one idea, and they would have drifted.

A lesson note deliberately does not also record the student. The lesson already knows whose
it is; a second copy is a second thing to keep true. It also means a student's notes and a
lesson's notes stay genuinely separate, which is how the app shows them.

Neither needs a capability. Writing something down is part of teaching, not administration —
what is gated is reaching the student or lesson at all, and `StudentsService.findOne` already
decides that. Only the author, or an admin, may remove a note.

## Push notifications

An announcement is a row per recipient **and** a push to every device they have
registered — in that order, and the push can never fail the request. The feed is where
an announcement lives; a push is a tap on the shoulder about it. A school whose
announcement failed to send because a phone was unreachable would be a worse outcome
than one whose phones stayed quiet.

`PushService` is a seam like `MailService`: `PUSH_TRANSPORT=log` writes notifications to
the server log, which is what makes the whole path testable with no Firebase project and no
device. `expo` sends through Expo's push service, in batches of 100.

`push_tokens` holds one row per **device**, and `token` is unique because of what that
implies. A phone can be handed to somebody else, or the same person can sign out and sign in
as a colleague, so registering a token that already exists *reassigns* it. A second row
would keep sending the school's announcements to whoever used the device first.

Dead tokens are dropped. `PushService` returns the tokens the push service rejected as
`DeviceNotRegistered` and the caller deletes them — and only that error, because anything
else may be transient and deleting a token over a temporary fault would silently stop
notifying somebody forever. Without this the table keeps every token the app has ever
issued, and each reinstall adds another.

The notification's body is the announcement text and its title is the school's name, both
untranslated. That is not laziness: the OS renders this while the app is not running, so the
server cannot ask which language the reader prefers. The only honest text is text that does
not depend on knowing — and the announcement is already in the language its author chose.

Announcements are delivered on their own Android channel rather than the lesson-reminder
one. Android lets people mute a channel, and "the school is telling you something" is worth
treating separately from "your lesson starts soon" — which also keeps the reminder chime
meaning one thing.

## Capabilities

Roles say what job somebody does; addons say what they are allowed to do. A school may want
one senior tutor who can invite colleagues without making them an admin, and roles alone
cannot express that.

**An admin always holds every capability.** They are the person who grants them, so
requiring an admin to grant themselves permission to grant permissions is a loop with no
useful first step. The rule is *decided*, never stored: an admin has no rows in
`user_addons` at all, so there is nothing to be out of date, nothing to migrate when a
capability is added, and nothing anybody can delete to take it away.

That only holds because every answer comes from one place. `AddonsService.resolveFor` is
the rule; `has` calls it, `AddonGuard` calls `has`, and the session payload calls
`resolveFor`. Adding a capability to the enum extends what an admin holds automatically,
and the tests compare against `Object.values(AddonKey)` rather than a written-out list so
that stays true.

The one function that used to read `user_addons` directly was `mapForSchool`, which the
roster is built from. It reported an admin as holding nothing — the exact inverse of the
rule — and it was unused, so nothing had noticed. It now resolves every member through the
same decision.

Granting is checked by **role, not capability**: handing out permissions is the one thing
that must not itself be delegable, or the boundary means nothing. `setFor` also refuses an
admin as a target, because there is nothing to grant them.

`setFor` replaces rather than adds. The admin UI shows a set of toggles and submits what it
wants to be true, which makes the operation idempotent and immune to a lost request leaving
half a state. That is also why `GET /schools/current/tutors` returns each member's
capabilities: the screen that lists members is the screen that edits them, and a toggle
computing its set from an empty one would quietly remove whatever the member already had.

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

`purpose` (`AVATAR`, `SCHOOL_LOGO`, `LESSON_ATTACHMENT`, `STUDENT_ATTACHMENT`, `OTHER`)
drives size limits and retention, and stops a lesson attachment being served as somebody's
avatar.

Files go through `StorageService`, a seam like `MailService`: the local disk is what a single
server needs, and object storage is a different implementation of four methods rather than a
change anywhere else. `UPLOADS_DIR` says where; `MAX_UPLOAD_MB` bounds how much one request
can cost.

The row is written **before** the bytes and finalised after, which is what `uploadedAt` is
for. If writing the bytes fails, what remains is a row with no `uploadedAt` — a record that
something was attempted, which can be found and cleared. The other order leaves bytes on
disk that nothing in the database knows about, and nothing can find those.

Types are an allow-list. The set of dangerous types grows over time and the set of useful
ones does not, so guessing wrong on an allow-list costs somebody an upload while guessing
wrong on a deny-list costs everybody. Downloads are `Content-Disposition: attachment` for
the same reason: these are files from outside the team, and rendering one in the browser's
own origin is how a stored file becomes a script that runs.


## Seed data

`prisma/seed.ts` creates the same cast as the app's fixtures — same names, same balances,
same announcement — and generates times **relative to now**: a lesson that has already
ended unconfirmed, one starting within the hour, two in the same slot on different
calendars. That is deliberate. It guarantees every notification kind and calendar state is
reachable whenever the seed runs, rather than only on the day the data was written. Keep it
that way when adding features.

Re-running the seed deletes and recreates the demo school, so it is safe to repeat.

## Deploying

`render.yaml` describes the service and its database, so a Render Blueprint
deploy needs no dashboard clicking beyond the secrets.

**Build command:** `npm run render:build`
**Start command:** `npm run start:prod`

The build is one script rather than a chain pasted into a dashboard, because two
of its steps are easy to drop and the failure is a dead deploy:

```bash
npm ci --include=dev          # devDependencies are needed to build
npm run db:generate           # the Prisma client is gitignored
npm run db:deploy             # apply migrations
npm run build
```

- **`--include=dev`** — `nest build` comes from `@nestjs/cli`, a devDependency.
  With `NODE_ENV=production` set, npm skips devDependencies and the build dies on
  `nest: not found`. The flag applies to the build step only; what ships is still
  the compiled `dist`.
- **`db:generate` before `build`** — the client is written to
  `generated/prisma`, which is not in version control, so a fresh clone has
  nothing to compile against.
- **`db:deploy` before the server starts** — a server that boots against an
  un-migrated database is worse than one that refuses to boot.
- **`&&`, not `;`** — chained with semicolons a failed migration still lets the
  deploy continue, and the first sign of trouble is a 500 at runtime.

Node is pinned in `.nvmrc` and `engines`. Left unpinned, the platform picks its
own default, and Prisma 7 on an older Node fails in a way that reads like a code
problem.

### Uploaded files

**Set `STORAGE_DRIVER=s3` on any host with an ephemeral filesystem** — which is
most PaaS free tiers, Render's included. Files written to local disk there
disappear on every redeploy, restart and wake-from-idle, while their rows in
`files` stay behind. Nothing reports an error: the list still shows the file and
opening it fails.

For AWS S3, four variables and no endpoint:

```
STORAGE_DRIVER=s3
S3_BUCKET=your-bucket
S3_REGION=eu-north-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
```

`S3_ENDPOINT` is only for a non-AWS store — Cloudflare R2, Backblaze, MinIO —
where the SDK cannot derive it from the region. Setting it also switches on
path-style addressing, which those stores serve and AWS no longer does for
buckets created since its virtual-host cutover.

The credentials belong to an IAM user, never to the root account, and the policy
needs exactly what `StorageService` does:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::your-bucket/*"
    }
  ]
}
```

No `ListBucket`: the code never enumerates the store, because the `files` table
is the record of truth and the bucket is only bytes.

Keep public access blocked. Downloads go through `GET /api/files/:id` behind
authentication, so the bucket itself never needs to be readable.

`STORAGE_DRIVER=s3` with any of the bucket, key or secret missing is refused at
**boot**, listing every missing variable at once — the alternative is a server
that starts happily and loses the first upload somebody cares about.

### Render's free tier, specifically

- A free Postgres instance **expires 30 days after creation**, with a 14-day
  grace period to upgrade before Render deletes it and its data. Storage is
  capped at 1 GB.
- A free web service **cannot have a persistent disk at all**, which is why the
  object store is not optional there.
- Free services spin down when idle, so the first request after a pause is slow.

## Not done yet

- **A user belongs to exactly one school.** A tutor working at two would need a membership
  join table — deliberately deferred until someone actually asks for it, since it changes
  every query.
- **Refresh tokens.** Access tokens last 7 days and there is no rotation or revocation.
- **Notification creation.** The table and read endpoints exist; nothing writes to it
  outside the seed. Payment reminders want a scheduled job.
- **Rate limiting** on sign-in, and structured request logging.
