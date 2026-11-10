// U2 acceptance contract (not a production formatter or a second implementation).
// U2.1: one explicit informational action on both real detail renderers.
// U2.2: no computation/announcement until activation; label the checked-at instant.
// U2.3: upcoming / underway / ended, including exact start/end boundaries and DST.
// U2.4: repeat activation recomputes; no timer, read, network, storage or notification.
// U2.5: polite announcement, keyboard activation, focus retained, no-JS/API fallback.
// U2.6: absolute times, device-zone controls, RSVP, SEO/cache authority stay unchanged.
// U2.7: cancelled remains gone; drafts never masquerade as upcoming published events.
// U2.8: invalid/non-finite/reversed instants have bounded, harmless output.
// U2.9 (Builder evidence, not proved by these assertions): design contract before
// UI work; retain Open Lobby/Logo 1 and semantic tokens; open real-route before /
// after desktop 1280x800 and mobile 390x844 shots plus required states on both
// twins; run a11y, lighthouse, lighthouse:quality and CI visual gates. Disclose
// that Hono gates do not exercise Kit. No threshold, mask, wholesale baseline,
// budget allowance or route-ownership changes; budget decisions are separate work.
//
// Stable DOM hooks below are the only new presentation wiring this suite pins.
// Copy is otherwise semantic. Rounding convention: ceil positive remaining minutes
// (a future boundary never says zero), decompose into days/hours/minutes, omit zero
// units. Exact boundaries switch state, not "starts in 0" / "ends in 0".
// Elapsed sub-minute wording is free; a whole-minute elapsed fixture is literal.
// Removing activation, using wall-clock subtraction through DST, rounding early,
// ticking autonomously or changing RSVP from the device clock must fail these tests.
export const timeFromNowIds = {
  button: "event-time-from-now-button",
  status: "event-time-from-now-status",
} as const;

export const timeFromNowWindow = {
  startsAt: "2030-03-10T09:30:00.000Z",
  endsAt: "2030-03-10T10:30:00.000Z",
  timezone: "America/Los_Angeles",
} as const;
export const timeFromNowServerTime = new Date("2030-03-01T12:00:00.000Z");

// Hand-computed elapsed durations, never obtained from a production helper.
export const timeFromNowCases = [
  {
    name: "U2.3 just before start (ceil, never zero)",
    now: "2030-03-10T09:29:59.999Z",
    state: /starts? in\b/i,
    distances: [/starts? in 1 minute\b/i, /ends? in 1 hour(?:,| and)? 1 minute\b/i],
  },
  {
    name: "U2.3 exact start is underway",
    now: "2030-03-10T09:30:00.000Z",
    state: /underway|in progress|has started/i,
    distances: [/ends? in 1 hour\b/i],
  },
  {
    name: "U2.3 just after start is underway",
    now: "2030-03-10T09:30:00.001Z",
    state: /underway|in progress|has started/i,
    distances: [/ends? in 1 hour\b/i],
  },
  {
    name: "U2.3 just before end (ceil, never zero)",
    now: "2030-03-10T10:29:59.999Z",
    state: /underway|in progress|has started/i,
    distances: [/ends? in 1 minute\b/i],
  },
  {
    name: "U2.3 exact end is ended",
    now: "2030-03-10T10:30:00.000Z",
    state: /ended|has finished/i,
    distances: [],
  },
  {
    name: "U2.3 just after end is ended",
    now: "2030-03-10T10:30:00.001Z",
    state: /ended|has finished/i,
    distances: [],
  },
  {
    name: "U2.3 whole minutes",
    now: "2030-03-10T09:28:00.000Z",
    state: /starts? in\b/i,
    distances: [/starts? in 2 minutes\b/i, /ends? in 1 hour(?:,| and)? 2 minutes\b/i],
  },
  {
    name: "U2.3 fractional minute rounds up consistently",
    now: "2030-03-10T09:28:59.999Z",
    state: /starts? in\b/i,
    distances: [/starts? in 2 minutes\b/i, /ends? in 1 hour(?:,| and)? 2 minutes\b/i],
  },
  {
    name: "U2.3 whole hours",
    now: "2030-03-10T07:30:00.000Z",
    state: /starts? in\b/i,
    distances: [/starts? in 2 hours\b/i, /ends? in 3 hours\b/i],
  },
  {
    name: "U2.3 days hours and minutes",
    now: "2030-03-08T06:26:00.000Z",
    state: /starts? in\b/i,
    distances: [
      /starts? in 2 days(?:,| and)? 3 hours(?:,| and)? 4 minutes\b/i,
      /ends? in 2 days(?:,| and)? 4 hours(?:,| and)? 4 minutes\b/i,
    ],
  },
  {
    name: "U2.3 elapsed event gives useful end distance",
    now: "2030-03-10T13:34:00.000Z",
    state: /ended|has finished/i,
    distances: [/3 hours(?:,| and)? 4 minutes ago\b/i],
  },
  {
    name: "U2.3 spring DST gap is one elapsed hour, not two wall hours",
    now: "2030-03-10T09:00:00.000Z",
    state: /starts? in\b/i,
    distances: [/starts? in 30 minutes\b/i, /ends? in 1 hour(?:,| and)? 30 minutes\b/i],
  },
  {
    name: "U2.3 autumn repeated hour still has thirty minutes left",
    now: "2030-11-03T09:00:00.000Z",
    startsAt: "2030-11-03T08:30:00.000Z",
    endsAt: "2030-11-03T09:30:00.000Z",
    state: /underway|in progress|has started/i,
    distances: [/ends? in 30 minutes\b/i],
  },
] as const;
