import { MeetingProvider } from '../../generated/prisma/enums';
import {
  MEETING_PROVIDERS,
  meetingLinkFor,
  meetingRoomProblem,
} from './meeting-providers';

describe('the provider list', () => {
  it('covers every provider the schema knows about', () => {
    // The `Record` already forces this at compile time. Asserted again because
    // the failure it prevents — a provider that books lessons with no link and
    // no error — is silent, and a compile-time guarantee is easy to weaken by
    // one `as` while chasing something else.
    for (const provider of Object.values(MeetingProvider)) {
      expect(MEETING_PROVIDERS[provider]).toBeDefined();
    }
  });
});

describe('a room address', () => {
  it('is accepted on the provider it belongs to', () => {
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'https://us05web.zoom.us/j/123'),
    ).toBeNull();
    expect(
      meetingRoomProblem(
        MeetingProvider.GOOGLE_MEET,
        'https://meet.google.com/abc-defg-hij',
      ),
    ).toBeNull();
  });

  it('is refused on another provider', () => {
    // Not pedantry: a Meet link saved under Zoom would be attached to every
    // lesson and would work, so nothing would ever reveal the mix-up — until
    // the day the setting is used to decide anything else.
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'https://meet.google.com/a-b-c'),
    ).not.toBeNull();
  });

  it('is refused on a host that merely ends with the right letters', () => {
    // The bug a suffix match makes: this domain is not Zoom's.
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'https://evilzoom.us/j/123'),
    ).not.toBeNull();
  });

  it('is accepted on a subdomain, which is where Zoom actually puts people', () => {
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'https://myschool.zoom.us/j/9'),
    ).toBeNull();
  });

  it('has to be https', () => {
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'http://zoom.us/j/123'),
    ).not.toBeNull();
  });

  it('cannot carry credentials', () => {
    // `https://zoom.us@evil.example/` reads as Zoom and goes somewhere else.
    expect(
      meetingRoomProblem(MeetingProvider.ZOOM, 'https://user:pw@zoom.us/j/1'),
    ).not.toBeNull();
  });

  it('is optional for a provider that reuses one room', () => {
    // Once an account can be connected, a tutor who has connected one needs no
    // address at all: rooms are made per lesson and this field is never read.
    // It used to be required, when pointing at an existing room was the only way
    // Zoom could produce a link.
    expect(meetingRoomProblem(MeetingProvider.ZOOM, null)).toBeNull();
    expect(meetingRoomProblem(MeetingProvider.ZOOM, '   ')).toBeNull();
  });

  it('is refused by a provider that makes a room per lesson', () => {
    expect(meetingRoomProblem(MeetingProvider.JITSI, null)).toBeNull();
    expect(
      meetingRoomProblem(MeetingProvider.JITSI, 'https://meet.jit.si/mine'),
    ).not.toBeNull();
  });

  it('is not a web address at all', () => {
    expect(meetingRoomProblem(MeetingProvider.ZOOM, 'zoom')).not.toBeNull();
  });
});

describe('the link a lesson gets', () => {
  it('is nothing at all for a tutor who teaches in a room', () => {
    expect(meetingLinkFor(null)).toBeNull();
  });

  it("is the tutor's own room, for a provider that reuses one", () => {
    expect(
      meetingLinkFor({
        provider: MeetingProvider.ZOOM,
        roomUrl: 'https://zoom.us/j/123',
      }),
    ).toEqual({ provider: MeetingProvider.ZOOM, url: 'https://zoom.us/j/123' });
  });

  it('is a new one every time, for a provider that generates them', () => {
    const first = meetingLinkFor({
      provider: MeetingProvider.JITSI,
      roomUrl: null,
    });
    const second = meetingLinkFor({
      provider: MeetingProvider.JITSI,
      roomUrl: null,
    });

    expect(first!.url).toMatch(/^https:\/\/meet\.jit\.si\/foxacademy-/);
    // Two lessons sharing a room would put one class in another class's call.
    expect(first!.url).not.toEqual(second!.url);
  });

  it('is unguessable, because the URL is the only thing keeping strangers out', () => {
    const room = meetingLinkFor({
      provider: MeetingProvider.JITSI,
      roomUrl: null,
    })!.url.split('/foxacademy-')[1];

    expect(room.length).toBeGreaterThanOrEqual(16);
  });

  it('produces nothing at all when there is no room and nothing connected', () => {
    // The settings are valid; there is simply no link to give. A lesson booked
    // like this is an ordinary lesson with no room, which is what somebody who
    // has chosen a provider and connected nothing has asked for.
    expect(
      meetingLinkFor({ provider: MeetingProvider.ZOOM, roomUrl: null }),
    ).toBeNull();
  });

  it('is nothing, rather than something broken, when the stored room no longer passes', () => {
    // A room an older build accepted. Better no link than one that 404s in front
    // of a student.
    expect(
      meetingLinkFor({
        provider: MeetingProvider.ZOOM,
        roomUrl: 'http://zoom.us/j/1',
      }),
    ).toBeNull();
  });
});
