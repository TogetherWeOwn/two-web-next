// Acceptance: Events — Discord DM reminder delivery mapping (web side).
//
// Slice 5 of the event-reminders design spec (§4.3–§4.4): what a reminder DM
// may say, who may receive one on which channel, and how a bot answer becomes
// a delivery outcome. Every test here fails until the Builder implements the
// module; there are no controls on existing seams in this file.
//
// Hermetic: pure functions only. No database, no fetch, no clock.
//
// Seams the Builder implements in a new module src/events/reminder-dm.ts
// (this file is never edited by the Builder):
//   1. `composeReminderDm({ title, startsAt, url }): string` — DM text from
//      event title/time/link only. The exact wording stays the Builder's
//      choice (copy wordsmithing happens later); only the presence of the three
//      event facts, the absence of any other member's data, and the 2000-
//      character dm.send body limit are pinned.
//   2. `resolveReminderChannels({ globalOptOut, siteEnabled, dmEnabled,
//      eventMuted }): { site, dm }` — per-channel preference (site vs DM)
//      alongside the global opt-out and the per-event mute. Precedence:
//      global opt-out wins over everything, per-event mute wins over channel
//      prefs, otherwise each channel follows its own toggle. The staging E2E
//      site+DM preference matrix reuses this truth table against persisted
//      prefs; the Builder wires these inputs to the profile columns and the
//      per-event mute table.
//   3. `mapDmSendOutcome(answer, windowOpen, attemptBackoffSeconds)` — a bot
//      answer plus the lead-window state becomes one delivery action:
//      `{ action: "record", status: "sent" | "dm_blocked" | "failed" |
//      "skipped_window" }` or `{ action: "retry", retryInSeconds }`.
//      Success answers carry `{ ok: true, replayed: boolean }`; failures are
//      the shared `BotFailure`. Retry delays ride the shared admission
//      (`admitRetryDelay` semantics): the bot's usable number, else this
//      attempt's backoff.
//   4. `mapDmTransportWait(windowOpen, attemptBackoffSeconds)` — the same
//      window rule for "could not ask" waits (bot down, deadline): retry with
//      the attempt backoff while the lead window is open, else
//      `skipped_window`. Never a silent fallback to another channel.
import { describe, expect, it } from "vitest";
import type { BotFailure } from "../src/jobs/types";
import {
  composeReminderDm,
  mapDmSendOutcome,
  mapDmTransportWait,
  resolveReminderChannels,
} from "../src/events/reminder-dm";

const EVENT = {
  title: "Movie Night",
  startsAt: new Date("2026-09-01T18:00:00Z"),
  url: "https://example.test/events/movie-night",
};
// Another member's data: must never appear in anyone's DM.
const DECOYS = ["someone-else", "100000000000007777", "someone-else@example.test"];

function failure(overrides: Partial<BotFailure> & { code: string }): BotFailure {
  return {
    ok: false,
    status: 422,
    requestId: "r1",
    message: "refused",
    retryable: false,
    retryAfterSeconds: null,
    ...overrides,
  };
}

describe("composeReminderDm — event title/time/link only", () => {
  it("contains the event title, the start time, and the event link", () => {
    const text = composeReminderDm(EVENT);
    expect(text).toContain("Movie Night");
    // Presence, not format: the exact time rendering is the Builder's choice.
    // The URL carries no year, so 2026 can only come from the time rendering.
    expect(text).toContain("2026");
    expect(text).toContain("https://example.test/events/movie-night");
  });

  it.each(DECOYS)("never carries another member's data: %j", (decoy) => {
    expect(composeReminderDm(EVENT)).not.toContain(decoy);
  });

  it("fits the dm.send body limit at maximal inputs", () => {
    // A 100-character title (the event name limit) plus a long link must
    // still compose inside the 2000-character body the contract accepts.
    const text = composeReminderDm({
      title: "t".repeat(100),
      startsAt: new Date("2026-09-01T18:00:00Z"),
      url: `https://example.test/events/${"u".repeat(200)}`,
    });
    expect(text).toContain("t".repeat(100));
    expect([...text].length).toBeLessThanOrEqual(2000);
  });
});

describe("resolveReminderChannels — site vs DM alongside mutes", () => {
  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("passes channel prefs through when subscribed: site=%s dm=%s", (site, dm) => {
    expect(
      resolveReminderChannels({
        globalOptOut: false,
        siteEnabled: site,
        dmEnabled: dm,
        eventMuted: false,
      }),
    ).toEqual({ site, dm });
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("global opt-out wins over every channel combination: site=%s dm=%s", (site, dm) => {
    expect(
      resolveReminderChannels({
        globalOptOut: true,
        siteEnabled: site,
        dmEnabled: dm,
        eventMuted: false,
      }),
    ).toEqual({ site: false, dm: false });
  });

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])("per-event mute wins over every channel combination: site=%s dm=%s", (site, dm) => {
    expect(
      resolveReminderChannels({
        globalOptOut: false,
        siteEnabled: site,
        dmEnabled: dm,
        eventMuted: true,
      }),
    ).toEqual({ site: false, dm: false });
  });

  it("opt-out plus mute together stay off", () => {
    expect(
      resolveReminderChannels({
        globalOptOut: true,
        siteEnabled: true,
        dmEnabled: true,
        eventMuted: true,
      }),
    ).toEqual({ site: false, dm: false });
  });

  it("a DM failure cannot enable site delivery: eligibility is prefs-only", () => {
    // No silent fallback: the same prefs resolve identically before and after
    // a dm_blocked, and a site-disabled member stays site-disabled.
    const prefs = { globalOptOut: false, siteEnabled: false, dmEnabled: true, eventMuted: false };
    expect(resolveReminderChannels(prefs)).toEqual({ site: false, dm: true });
    expect(resolveReminderChannels({ ...prefs })).toEqual(resolveReminderChannels(prefs));
  });
});

describe("mapDmSendOutcome — bot answer to delivery status", () => {
  it("success records sent", () => {
    expect(mapDmSendOutcome({ ok: true, replayed: false }, true, 30)).toEqual({
      action: "record",
      status: "sent",
    });
  });

  it("replayed success still records one sent — a replayed key never sends twice", () => {
    // The bot dedupes by key server-side; the web side records the replay as
    // the same single send, never a second delivery and never a retry.
    expect(mapDmSendOutcome({ ok: true, replayed: true }, true, 30)).toEqual({
      action: "record",
      status: "sent",
    });
  });

  it("dm_blocked records dm_blocked and never retries, window open or not", () => {
    const blocked = failure({ code: "dm_blocked", status: 422, retryable: false });
    expect(mapDmSendOutcome(blocked, true, 30)).toEqual({ action: "record", status: "dm_blocked" });
    expect(mapDmSendOutcome(blocked, false, 30)).toEqual({
      action: "record",
      status: "dm_blocked",
    });
  });

  it("any other non-retryable failure records failed", () => {
    expect(mapDmSendOutcome(failure({ code: "malformed", status: 400 }), true, 30)).toEqual({
      action: "record",
      status: "failed",
    });
  });

  it("retryable 429 while the window is open retries with the admitted backoff", () => {
    const limited = failure({
      code: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 2,
    });
    expect(mapDmSendOutcome(limited, true, 30)).toEqual({ action: "retry", retryInSeconds: 2 });
  });

  it("retryable 429 with an unusable delay falls back to this attempt's backoff", () => {
    const limited = failure({
      code: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: null,
    });
    expect(mapDmSendOutcome(limited, true, 30)).toEqual({ action: "retry", retryInSeconds: 30 });
  });

  it("retryable 429 after the window closed records skipped_window, never a retry", () => {
    const limited = failure({
      code: "rate_limited",
      status: 429,
      retryable: true,
      retryAfterSeconds: 2,
    });
    expect(mapDmSendOutcome(limited, false, 30)).toEqual({
      action: "record",
      status: "skipped_window",
    });
  });

  it("any retryable failure honors the same window rule", () => {
    const unavailable = failure({ code: "discord_unavailable", status: 503, retryable: true });
    expect(mapDmSendOutcome(unavailable, true, 30)).toEqual({
      action: "retry",
      retryInSeconds: 30,
    });
    expect(mapDmSendOutcome(unavailable, false, 30)).toEqual({
      action: "record",
      status: "skipped_window",
    });
  });
});

describe("mapDmTransportWait — bot-down waits honor the window", () => {
  it("retries with the attempt backoff while the window is open", () => {
    expect(mapDmTransportWait(true, 30)).toEqual({ action: "retry", retryInSeconds: 30 });
  });

  it("records skipped_window after the window closed", () => {
    expect(mapDmTransportWait(false, 30)).toEqual({ action: "record", status: "skipped_window" });
  });
});
