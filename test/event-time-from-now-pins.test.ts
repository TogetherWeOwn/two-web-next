// Implementation-owned pins for the time-from-now row. The independent
// acceptance contract is test/event-time-from-now-acceptance.test.ts and
// ci/event-time-from-now.test.mjs (Test Author owned, never edited here);
// these cases pin what they do not: the instants the island reads equal the
// visible host <time> values, the island is loaded, and the row is not
// offered on drafts.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { scheduleCases } from "./fixtures/event-scheduled-range";
import { timeFromNowServerTime, timeFromNowWindow } from "./fixtures/event-time-from-now";
import {
  compileScheduleKit,
  renderScheduledPage,
  scheduledEvent,
  type KitRenderer,
} from "./helpers/event-scheduled-range";

function render(status: PublicEvent["status"]) {
  const start = new Date("2030-01-10T20:00:00Z");
  const e = {
    id: 1,
    icsSequence: 1n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Voice lobby",
    capacity: 10,
    status,
    rsvpOpen: true,
    goingCount: 2,
    goingOccupancy: 2,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    syncRevision: 1,
    syncedRevision: 0,
    createdAt: start,
    updatedAt: start,
  } as PublicEvent;
  return String(
    EventPage({
      e,
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: "https://next.example.test",
      jsonLd: "{}",
    }),
  );
}

describe("event time-from-now served-markup pins", () => {
  it("serves a hidden row whose instants equal the visible host times", () => {
    const html = render("published");
    const row = html.slice(html.indexOf("<dt>Time from now</dt>"));
    expect(row).toContain('data-starts-at="2030-01-10T20:00:00.000Z"');
    expect(row).toContain('data-ends-at="2030-01-10T22:00:00.000Z"');
    expect(html).toContain('<time datetime="2030-01-10T20:00:00.000Z">');
    expect(html).toContain('<time datetime="2030-01-10T22:00:00.000Z">');
    // The whole row is hidden until the island binds, so no-JS shows no dead label.
    expect(html.slice(0, html.indexOf("<dt>Time from now</dt>"))).toMatch(/<div hidden="">$/);
    expect(html).toContain('<script src="/islands/event-time-from-now.js" defer="">');
    // The reveal must not move content at any script timing: hidden detail
    // rows keep their laid-out size via visibility reservation in the
    // render-blocking event stylesheet (a deferred-only reveal loses the
    // first-paint race and the quality gate records CLS on the event page).
    const theme = readFileSync("public/event-theme.css", "utf8");
    expect(theme).toContain(
      ".event-theme .event-meta div[hidden]{display: block;visibility: hidden}",
    );
    expect(theme).toContain(
      ".event-theme .event-meta button[hidden],.event-theme .event-meta input[hidden]{display: inline-block;visibility: hidden}",
    );
  });
  it("does not offer the action on a draft", () => {
    expect(render("draft")).not.toContain("data-event-time-from-now");
  });
});

// The shipped (minified) island runs against a minimal fake document so the
// sentence for an exact instant triple can be asserted without a browser.
const shipped = readFileSync("public/islands/event-time-from-now.js", "utf8");
const MIN = 60_000;
const NOW = Date.parse("2030-01-10T12:00:00Z");

function activate(startMs: number, endMs: number, nowMs: number) {
  const result = { textContent: "", append: () => {} };
  let click: () => void = () => {};
  const root = {
    dataset: {
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
    },
    parentElement: { hidden: true },
    querySelector: (selector: string) =>
      selector === "button"
        ? { hidden: true, addEventListener: (_: string, fn: () => void) => (click = fn) }
        : result,
  };
  const document = {
    querySelectorAll: () => [root],
    createElement: () => ({ dateTime: "", textContent: "" }),
  };
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(nowMs);
  new Function("document", shipped)(document);
  click();
  return result.textContent;
}

describe("event time-from-now sentence boundaries (shipped bytes)", () => {
  afterEach(() => vi.useRealTimers());
  const HOUR = 60 * MIN;
  const LIMIT = 36500 * 1440; // minutes; the island's century cap

  it("rounds an elapsed end down and calls under a minute 'less than a minute'", () => {
    const ends = NOW - 5 * HOUR;
    const starts = ends - HOUR;
    expect(activate(starts, ends, ends)).toBe("Ended less than a minute ago.");
    expect(activate(starts, ends, ends + 30_000)).toBe("Ended less than a minute ago.");
    expect(activate(starts, ends, ends + 59_999)).toBe("Ended less than a minute ago.");
    expect(activate(starts, ends, ends + MIN)).toBe("Ended 1 minute ago.");
    // Floor, not round or ceil: 119s is still one minute.
    expect(activate(starts, ends, ends + 119_000)).toBe("Ended 1 minute ago.");
    expect(activate(starts, ends, ends + 2 * MIN)).toBe("Ended 2 minutes ago.");
  });

  it("rounds a future instant up so a sub-minute remainder is one minute", () => {
    expect(activate(NOW + 30_000, NOW + HOUR, NOW)).toBe("Starts in 1 minute. Ends in 1 hour.");
    expect(activate(NOW + MIN + 1, NOW + HOUR, NOW)).toBe("Starts in 2 minutes. Ends in 1 hour.");
  });

  it("caps a future span past a century and keeps the exact century as days", () => {
    const edge = NOW + LIMIT * MIN;
    expect(activate(edge, edge + MIN, NOW)).toBe(
      "Starts in 36500 days. Ends in more than 100 years.",
    );
    expect(activate(edge - MIN, edge, NOW)).toBe(
      "Starts in 36499 days, 23 hours and 59 minutes. Ends in 36500 days.",
    );
  });

  it("caps an elapsed span past a century the same way", () => {
    const ends = NOW - LIMIT * MIN;
    expect(activate(ends - HOUR, ends, NOW)).toBe("Ended 36500 days ago.");
    expect(activate(ends - HOUR, ends - MIN, NOW)).toBe("Ended more than 100 years ago.");
  });
});

describe("event time-from-now Kit twin, no JS", () => {
  let kit: KitRenderer;
  beforeAll(async () => {
    kit = await compileScheduleKit();
  });
  for (const twin of ["Hono", "Kit"] as const) {
    it(`${twin} wraps the whole row in a hidden block until the island binds`, async () => {
      const { html } = await renderScheduledPage(
        twin,
        scheduledEvent(scheduleCases[0], {
          startsAt: new Date(timeFromNowWindow.startsAt),
          endsAt: new Date(timeFromNowWindow.endsAt),
          timezone: timeFromNowWindow.timezone,
          status: "published",
        }),
        "guest",
        kit,
        timeFromNowServerTime,
      );
      // A dt with no visible control would be a dead label for visitors without JS.
      expect(html).toMatch(/<div hidden(?:="")?>\s*<dt>Time from now<\/dt>/);
      const row = html.slice(html.indexOf("<dt>Time from now</dt>"));
      expect(row).toContain(`data-starts-at="${timeFromNowWindow.startsAt}"`);
      expect(row).toContain(`data-ends-at="${timeFromNowWindow.endsAt}"`);
    });
  }
});

describe("event time-from-now CI wiring", () => {
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const a11yJob = ci.slice(ci.indexOf("\n  a11y:\n"), ci.indexOf("\n  check:\n"));
  const step =
    a11yJob.split("\n      - name: ").find((s) => s.startsWith("Event time from now")) ?? "";

  it("runs the browser suite in the a11y job and requires every case to execute", () => {
    expect(step).not.toBe("");
    expect(step).toContain(
      "node --import tsx --test --test-timeout=60000 --test-reporter=tap --test-reporter-destination=artifacts/a11y/event-time-from-now.tap ci/event-time-from-now.test.mjs",
    );
    expect(step).toContain(
      'node ci/rsvp-focus-require-executed.mjs artifacts/a11y/event-time-from-now.tap "Hono time-from-now browser acceptance" 28',
    );
    expect(step).toContain(
      'node ci/rsvp-focus-require-executed.mjs artifacts/a11y/event-time-from-now.tap "Kit time-from-now browser acceptance" 28',
    );
  });

  it("keeps the step unconditional and its failures fatal", () => {
    // Any step-level key besides run (continue-on-error, if, shell, timeout-minutes)
    // can make a failing or skipped suite pass the job without anyone noticing.
    const stepKeys = step.split("\n").filter((line) => /^ {8}\S/.test(line));
    expect(stepKeys).toEqual(["        run: |"]);
    // The suite and both verifiers must run unguarded, one command per line.
    const commands = step
      .split("\n")
      .filter((line) => /^ {10}\S/.test(line))
      .map((line) => line.trim());
    expect(commands).toHaveLength(4);
    for (const command of commands.slice(1)) {
      expect(command).not.toMatch(/\|\||&&|;|\bset \+e\b|\btrue\b|^#/);
    }
    // A job-level override would soften every step in the job, this one included.
    expect(a11yJob).not.toMatch(/^ {4}continue-on-error:/m);
  });
});
