import { randomBytes } from 'node:crypto';

import { MeetingProvider } from '../../generated/prisma/enums';

/**
 * How a link for one provider comes about.
 *
 * Two genuinely different kinds, and the difference is not a detail: one gives
 * every lesson its own room, the other reuses the room the tutor already owns.
 *
 * `generated` is what "a link per lesson" means literally, and the only kind
 * that needs nothing from the tutor. `personalRoom` is where Zoom and Google
 * Meet sit today, because neither will mint a meeting for somebody without that
 * person's own OAuth consent — Meet's `spaces.create` needs the
 * `meetings.space.created` scope held by the account the room belongs to, and
 * Zoom the equivalent. There is no URL either of them can be talked into
 * creating from the outside, so a room the tutor already has is the honest
 * substitute until that consent flow exists.
 *
 * Adding the OAuth kind later is a third member here and a compiler error at
 * every switch that has not handled it. Nothing that calls this has to change.
 */
type LinkKind =
  | {
      kind: 'personalRoom';
      /**
       * Hosts a room link may live on. Matched exactly or as a parent domain,
       * because Zoom hands out per-region and per-company subdomains.
       */
      hosts: readonly string[];
      /** Shown in settings, so somebody knows what they are being asked for. */
      exampleRoomUrl: string;
    }
  | { kind: 'generated'; build: () => string };

/**
 * Everything that differs between providers, in one place.
 *
 * A `Record` keyed by the enum rather than a lookup with a fallback: a provider
 * added to the schema and forgotten here fails to compile, which is the whole
 * reason the list is an enum and not a string.
 */
export const MEETING_PROVIDERS: Readonly<Record<MeetingProvider, LinkKind>> = {
  [MeetingProvider.ZOOM]: {
    kind: 'personalRoom',
    hosts: ['zoom.us'],
    exampleRoomUrl: 'https://us05web.zoom.us/j/1234567890',
  },
  [MeetingProvider.GOOGLE_MEET]: {
    kind: 'personalRoom',
    hosts: ['meet.google.com'],
    exampleRoomUrl: 'https://meet.google.com/abc-defg-hij',
  },
  [MeetingProvider.JITSI]: {
    kind: 'generated',
    // Long and random on purpose. A Jitsi room exists the moment somebody opens
    // it and admits anybody holding the URL, so the name is the only thing
    // keeping a stranger out — a guessable one ("foxacademy-lesson-12") is an
    // open door into a lesson with children in it. Twelve random bytes is more
    // than a guessing attack gets through.
    build: () =>
      `https://meet.jit.si/foxacademy-${randomBytes(12).toString('base64url')}`,
  },
};

/** What a tutor has chosen, as stored in their config. */
export type MeetingSettings = {
  provider: MeetingProvider;
  /**
   * The tutor's own room, for providers that reuse one. Null for providers that
   * generate a room per lesson, which is why the pair lives in one object: a
   * room without a provider means nothing, and the two disagreeing is a state
   * the type should not allow.
   */
  roomUrl: string | null;
};

/** No longer than any real meeting URL, and short enough to store and send. */
const MAX_ROOM_URL = 500;

/**
 * Why this room link cannot be used, in words a person can act on — or null if
 * it can.
 *
 * An empty room is acceptable for a provider that reuses one: the tutor may have
 * connected their account instead, in which case rooms are created per lesson and
 * this field is never read.
 *
 * A function returning a reason rather than a boolean because every caller here
 * needs the reason: the API answers with it, and the settings screen shows it
 * under the field.
 */
export function meetingRoomProblem(
  provider: MeetingProvider,
  roomUrl: string | null,
): string | null {
  const rules = MEETING_PROVIDERS[provider];

  if (rules.kind === 'generated') {
    // Not merely unnecessary — accepting it would mean storing an address that
    // is then silently ignored at booking time, and somebody would spend an
    // afternoon wondering why their link never appears.
    return roomUrl === null
      ? null
      : 'This provider creates a room for each lesson, so it takes no room address';
  }

  // Optional, since connecting an account exists. It used to be required here,
  // because pointing at a room the tutor already owned was the only way Zoom or
  // Meet could produce a link at all; now it is the fallback for a tutor who has
  // not connected one, or for the minute the provider is unreachable. Somebody
  // who has connected an account needs nothing in this field, and demanding it
  // would be asking for an address to paper over a case that no longer exists.
  if (roomUrl === null || roomUrl.trim() === '') return null;

  if (roomUrl.length > MAX_ROOM_URL) {
    return 'That address is too long to be a meeting room';
  }

  let parsed: URL;
  try {
    parsed = new URL(roomUrl);
  } catch {
    return 'That is not a web address';
  }

  // Only https. A meeting link is passed on to students, and one that downgrades
  // the connection is worth refusing rather than repairing quietly.
  if (parsed.protocol !== 'https:') {
    return 'A meeting room address has to start with https://';
  }
  // Credentials in a URL are either a mistake or an attempt to make a link read
  // as one host while going to another.
  if (parsed.username !== '' || parsed.password !== '') {
    return 'A meeting room address cannot carry a username or password';
  }
  if (!isHostOf(parsed.hostname, rules.hosts)) {
    return `That address is not on ${rules.hosts.join(' or ')}`;
  }

  return null;
}

/** Exact host, or any subdomain of it. Never a suffix match on the raw string:
 *  "evilzoom.us" ends with "zoom.us" and belongs to somebody else. */
function isHostOf(hostname: string, hosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return hosts.some(
    (allowed) => host === allowed || host.endsWith(`.${allowed}`),
  );
}

/**
 * The link to put on a lesson being booked, or null if this tutor teaches in a
 * room.
 *
 * Called once, when the lesson is created, and the result is stored — see the
 * note on `Lesson.meetingUrl` for why it is never recomputed.
 */
export function meetingLinkFor(
  settings: MeetingSettings | null,
): { provider: MeetingProvider; url: string } | null {
  if (settings === null) return null;

  const rules = MEETING_PROVIDERS[settings.provider];

  switch (rules.kind) {
    case 'generated':
      return { provider: settings.provider, url: rules.build() };
    case 'personalRoom':
      // Two ways to get nothing here, and both have to be nothing rather than a
      // half-answer. No address at all, from a tutor who has connected an
      // account instead — this function is the fallback, and there is none. Or an
      // address that no longer validates, stored by an older build or one that
      // allowed a host this one does not.
      //
      // Returning a provider with a null link would record a lesson as being
      // held on Zoom with nowhere to join.
      if (settings.roomUrl === null) return null;

      return meetingRoomProblem(settings.provider, settings.roomUrl) === null
        ? { provider: settings.provider, url: settings.roomUrl }
        : null;
  }
}
