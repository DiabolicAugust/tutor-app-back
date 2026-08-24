import { Throttle } from '@nestjs/throttler';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;

/**
 * Two windows, applied to every route at once.
 *
 * One window is not enough. A per-minute limit stops a flood but lets somebody
 * sit just under it for a day; a per-hour limit catches that but allows a burst
 * big enough to hurt before it notices. Both together bound the shape as well as
 * the volume.
 *
 * The numbers are generous for a person and cheap for the server: the app's
 * busiest screen makes a handful of requests, so a real user is nowhere near
 * these, and anything that is has stopped behaving like a user.
 */
export const GLOBAL_THROTTLERS = [
  { name: 'short', ttl: MINUTE_MS, limit: 120 },
  { name: 'long', ttl: HOUR_MS, limit: 1_500 },
] as const;

/**
 * What signing in is allowed to cost.
 *
 * The tightest limit in the application, and the most important one. Every
 * attempt runs a bcrypt comparison at cost factor 12 — around a quarter of a
 * second of processor time, deliberately, because that is what makes a stolen
 * password database expensive to crack. It also means a few hundred requests a
 * second is enough to stop the server answering anybody at all, with no
 * botnet and no cleverness.
 *
 * Ten a minute is more than a person who has forgotten their password needs, and
 * forty an hour ends a slow credential-stuffing run that a per-minute limit
 * alone would let continue all day.
 */
export const ThrottleSignIn = () =>
  Throttle({
    short: { limit: 10, ttl: MINUTE_MS },
    long: { limit: 40, ttl: HOUR_MS },
  });

/**
 * Creating a school, and creating an account from an invitation.
 *
 * Both write rows nobody asked for if they are abused, and both hash a password
 * on the way — so they are limited for the same two reasons as signing in. A
 * person opens one school, once.
 */
export const ThrottleRegistration = () =>
  Throttle({
    short: { limit: 3, ttl: MINUTE_MS },
    long: { limit: 10, ttl: HOUR_MS },
  });

/**
 * Reading an invitation by its token.
 *
 * The token is 256 bits from `randomBytes`, so this is not about guessing — it
 * cannot be guessed. It is about volume: the endpoint is public, it takes a
 * database round trip, and nothing else stands in front of it.
 */
export const ThrottleInvitationLookup = () =>
  Throttle({
    short: { limit: 20, ttl: MINUTE_MS },
    long: { limit: 100, ttl: HOUR_MS },
  });

/**
 * Uploading a file.
 *
 * Counted per account, like every authenticated route. The size of any one
 * upload is capped by the interceptor and the total by the school's quota; this
 * caps the *rate*, which is what the other two do not — a thousand small files
 * pass both and still cost a thousand round trips and a thousand rows.
 */
export const ThrottleUpload = () =>
  Throttle({
    short: { limit: 20, ttl: MINUTE_MS },
    long: { limit: 200, ttl: HOUR_MS },
  });

/**
 * Anything that leaves the server addressed to other people: an announcement to
 * a whole school, a support request to us.
 *
 * A limit here is not about load. It is about not being the instrument: an
 * account that can push a notification to every phone in a school on demand is
 * a spam channel, and one that can mail support without limit is a way to bury
 * the inbox everybody else's problems arrive in.
 */
export const ThrottleBroadcast = () =>
  Throttle({
    short: { limit: 5, ttl: MINUTE_MS },
    long: { limit: 30, ttl: HOUR_MS },
  });

export const ThrottleSupport = () =>
  Throttle({
    short: { limit: 3, ttl: MINUTE_MS },
    long: { limit: 10, ttl: HOUR_MS },
  });
