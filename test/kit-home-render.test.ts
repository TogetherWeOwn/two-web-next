// Kit home SSR render contract: the real +page.svelte, compiled with the web
// workspace's svelte/compiler and bundled by esbuild (the same harness as
// ci/kit-preview-e2e.mjs), rendered with fake load data. String presence in
// source cannot catch a wrong branch — these renders fail the three mutants
// the source-grep suite missed: a hardcoded sessionUnavailable, a skipped
// flash precedence, and `{:else if session}` in the hero.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_RANKS, HOME_JOIN_RESULT_COPY, HOME_NOTICES, JOIN_INTRO } from "../src/home-copy";
import { createKitSsrRenderer, type RenderPage } from "./helpers/kit-ssr-render";

let renderPage: RenderPage;
let cleanup: (() => void) | undefined;

const INVITE_URL = "https://discord.gg/invite";
const APP_URL = "https://example.test";
const JSON_LD_BLOCK =
  /<script type="application\/ld\+json" data-testid="([^"]+)">([\s\S]*?)<\/script>/g;

function baseData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session: null,
    sessionUnavailable: false,
    notice: null,
    joinResult: null,
    inviteUrl: INVITE_URL,
    appUrl: APP_URL,
    counts: { memberCount: 42, onlineCount: 7, ranks: [] },
    countsSnapshot: {
      memberCount: 42,
      onlineCount: 7,
      observedAt: "2026-09-30T12:00:00.000Z",
      stale: false,
    },
    upcomingEvents: [],
    eventsUnavailable: false,
    featured: [],
    imageHosts: "",
    homeCopy: { HOME_NOTICES, HOME_JOIN_RESULT_COPY, FALLBACK_RANKS, JOIN_INTRO },
    ...overrides,
  };
}

const memberSession = {
  userId: "member-1",
  username: "Member",
  avatar: null,
  member: true,
  moderator: false,
};

const nonMemberSession = {
  ...memberSession,
  userId: "player-1",
  username: "Player",
  member: false,
};

beforeAll(async () => {
  ({ renderPage, cleanup } = await createKitSsrRenderer("web/src/routes/+page.svelte"));
}, 60000);

afterAll(() => {
  cleanup?.();
});

describe("Kit home SSR render: session-aware header and hero", () => {
  it("keeps the hero truthful without voice or personal RSVP data", () => {
    for (const session of [null, memberSession]) {
      const html = renderPage(baseData({ session }));
      const hero = html.split('<section class="hero')[1]!.split("</section>")[0]!;
      expect(hero).toContain('id="home-heading"');
      expect(hero).toContain("The lobby is <em>open</em>.");
      expect(hero).toContain('data-testid="member-count"');
      expect(hero).not.toContain("In voice now");
      expect(hero).not.toContain("Pull me into");
      expect(hero).not.toContain("You're in for");
    }
  });

  it.each([false, true])(
    "shows zero online without inferring voice activity (stale=%s)",
    (stale) => {
      const html = renderPage(
        baseData({
          countsSnapshot: {
            memberCount: 42,
            onlineCount: 0,
            observedAt: "2026-09-30T12:00:00.001Z",
            stale,
          },
          upcomingEvents: [fullnessEvent({ title: "Synthetic game night" })],
        }),
      );
      expect(html).toContain("Synthetic game night");
      expect(html).toContain("0</strong> online");
      expect(html).not.toContain("It's quiet right now");
      expect(html).not.toContain("evenings are busiest");
      expect(html).not.toContain("In voice now");
      if (stale) {
        expect(html).toContain('data-stale="true"');
        expect(html).toContain("Last seen");
        expect(html).toContain('datetime="2026-09-30T12:00:00.001Z"');
        expect(html).toContain("2026-09-30 12:00:00.001 UTC");
      } else {
        expect(html).not.toContain("Last seen");
      }
    },
  );

  it("renders the guest header with the Discord join entry point", () => {
    const html = renderPage(baseData());
    expect(html).toContain('data-testid="signin"');
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain('data-testid="join-result"');
    expect(html).not.toContain('data-testid="notice"');
  });

  it("renders Home landmarks and preserves the restored-write and sign-in recovery", () => {
    const html = renderPage(baseData({ restoredWrite: true, notice: "signin_failed" }));
    expect(html.match(/<header\b/g)).toHaveLength(1);
    expect(html).toMatch(/<footer class="ember-footer\b[^>]*>[\s\S]*?<nav aria-label="Footer"/);
    expect(html).toContain('href="/auth/discord" data-testid="notice-retry"');
    expect(html).toContain("Your earlier changes were not saved.");
    expect(html.indexOf('data-testid="auth-error"')).toBeLessThan(
      html.indexOf('id="home-heading"'),
    );
    expect(html).toContain('<meta name="description"');
  });

  it("does not render attendee names from an event fixture for a guest", () => {
    const event = fullnessEvent({
      title: "Public game night",
      organizer_name: "SyntheticHostName",
      attendees: [{ username: "SyntheticPrivateName" }],
    });
    const html = renderPage(baseData({ upcomingEvents: [event] }));
    expect(html).toContain("Next game night: <em>Public game night</em>");
    expect(html).toContain("1 of 4 going");
    expect(html).not.toContain("SyntheticPrivateName");
    expect(html).not.toContain("SyntheticHostName");
  });

  it("renders the member header with the invite URL and no join entry point", () => {
    const html = renderPage(baseData({ session: memberSession }));
    expect(html).toContain('<form method="post" action="/logout">');
    expect(html).toContain("Member");
    expect(html).toContain(`href="${INVITE_URL}">Open Discord</a>`);
    expect(html).not.toContain('data-testid="signin"');
    expect(html).not.toContain('data-testid="join"');
  });

  it("renders the Discord join entry point for a signed-in non-member", () => {
    // Kills the `{:else if session}` hero mutant, which hands non-members
    // the member's Open Discord button.
    const html = renderPage(baseData({ session: nonMemberSession }));
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain(`href="${INVITE_URL}">Open Discord</a>`);
  });

  it("offers the invite-link hero during a session outage, even with live events", () => {
    // Kills the `sessionUnavailable = false` mutant: with no events outage
    // the fallback link below the hero cannot mask the missing hero button.
    const html = renderPage(baseData({ sessionUnavailable: true, eventsUnavailable: false }));
    expect(html).toContain("Welcome, guest");
    expect(html).toContain('data-testid="discord-join">Join with an invite link</a>');
  });
});

describe("Kit home SSR render: highlights", () => {
  it("renders four sourced highlights and preserves the community links", () => {
    const html = renderPage(baseData());
    const highlights = html.split('data-testid="home-highlights"')[1]!.split("</ul>")[0]!;
    expect(highlights.match(/<li>/g)).toHaveLength(4);
    expect(html).toContain('id="community-heading"');
    expect(html).toContain('id="discord-heading"');
    expect(html).toContain('href="/join#join-heading" data-testid="home-widget-link"');
    expect(html).toContain('href="/discord" data-testid="home-discord-invite"');
    for (const unsupported of ["Raid Night", "Grand Prix", "resets each month", "public log"]) {
      expect(html).not.toContain(unsupported);
    }
  });
});

describe("Kit home SSR render: join band", () => {
  function band(html: string): string {
    return html.split('<section class="join-band"')[1]?.split("</section>")[0] ?? "";
  }

  it("offers the shared introduction and sign-in to guests and non-members", () => {
    for (const session of [null, nonMemberSession]) {
      const content = band(renderPage(baseData({ session })));
      expect(content).toContain("Pull up a");
      expect(content).toContain(JOIN_INTRO);
      expect(content).toContain('href="/auth/discord" data-testid="join-band-join"');
    }
  });

  it("suppresses the whole band for members, even after join failure", () => {
    for (const notice of [null, "join_failed"]) {
      expect(band(renderPage(baseData({ session: memberSession, notice })))).toBe("");
    }
  });

  it("prioritizes the outage invite over a join failure", () => {
    const content = band(renderPage(baseData({ sessionUnavailable: true, notice: "join_failed" })));
    expect(content).toContain("Sign-in isn't answering right now.");
    expect(content).toContain('href="/discord" data-testid="join-band-invite"');
    expect(content).not.toContain('data-testid="join-band-join"');
    expect(content).not.toContain("The bot couldn't add you");
  });

  it("offers the configured invite after a healthy non-member join failure", () => {
    const content = band(
      renderPage(baseData({ session: nonMemberSession, notice: "join_failed" })),
    );
    expect(content).toContain("The bot couldn't add you just now.");
    expect(content).toContain(`href="${INVITE_URL}" data-testid="join-band-invite"`);
    expect(content).not.toContain('data-testid="join-band-join"');
  });
});

describe("Kit home SSR render: notice slot and one-shot flash", () => {
  it("renders the flashed confirmation ahead of any notice", () => {
    const html = renderPage(baseData({ notice: "joined", joinResult: "added" }));
    expect(html).toContain('data-testid="join-result"');
    expect(html).toContain(HOME_JOIN_RESULT_COPY.added);
    expect(html).not.toContain('data-testid="notice"');
  });

  it("renders the reinvite action for an already-member flash", () => {
    const html = renderPage(baseData({ joinResult: "already_member" }));
    expect(html).toContain(HOME_JOIN_RESULT_COPY.alreadyInServer);
    expect(html).toContain('data-testid="reinvite-link"');
  });

  it("renders a failure notice with no banner when the flash is suppressed", () => {
    const html = renderPage(baseData({ notice: "join_failed", joinResult: null }));
    expect(html).toContain('data-testid="notice"');
    expect(html).toContain(HOME_NOTICES.join_failed);
    expect(html).not.toContain('data-testid="join-result"');
  });
});

describe("Kit home SSR render: independently degraded panels", () => {
  it("does not substitute legacy counts when the snapshot is unavailable", () => {
    const html = renderPage(baseData({ countsSnapshot: null }));
    expect(html).not.toContain('data-testid="member-count"');
    expect(html).not.toContain("Last seen");
    // The ladder still names the ranks with the shared fallback.
    expect(html).toContain('data-testid="rank-stack"');
    expect(html).toContain("Prospect");
    expect(html).toContain("Legend");
  });

  it("reads a zero rank as unclaimed", () => {
    const html = renderPage(
      baseData({
        counts: {
          memberCount: 10,
          onlineCount: null,
          ranks: [{ key: "prospect", label: "Prospect", memberCount: 0 }],
        },
      }),
    );
    expect(html).toContain("unclaimed");
  });

  it("names the empty schedule and keeps the join entry point", () => {
    const html = renderPage(baseData());
    expect(html).toContain('data-testid="home-events-empty"');
    expect(html).toContain("Nothing scheduled yet.");
    expect(html).toContain('data-testid="home-events-join"');
    for (const session of [null, memberSession]) {
      const empty = renderPage(baseData({ session }));
      expect(empty).toContain('href="/discord" data-testid="home-suggest-event"');
      expect(empty).toContain("Suggest an event in Discord");
    }
  });

  it("states the events outage without hiding the rest of the page", () => {
    const html = renderPage(baseData({ eventsUnavailable: true }));
    expect(html).toContain('data-state="unavailable"');
    expect(html).toContain("Game nights are unavailable right now.");
    expect(html).toContain("<strong>Schedule unavailable</strong>");
    expect(html).not.toContain('data-testid="home-suggest-event"');
    expect(html).toContain('data-testid="member-count"');
  });

  it("renders visible featured rows and a canonical event link", () => {
    const html = renderPage(
      baseData({
        featured: [{ id: "f1", title: "Night report", body: "We played.", url: null }],
        upcomingEvents: [
          {
            source: "canonical",
            eventKey: "game-night-1",
            title: "Game night",
            startsAt: new Date(Date.UTC(2026, 9, 20, 19, 0, 0)),
            timezone: "Europe/London",
            location: null,
            goingCount: 3,
            capacity: null,
          },
        ],
      }),
    );
    expect(html).toContain('data-testid="featured-content"');
    expect(html).toContain('data-testid="featured-item"');
    expect(html).toContain("Night report");
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain('href="/e/game-night-1"');
    expect(html).toContain("3 going");
  });

  it("renders the event band for guests and members without invented live or personal state", () => {
    const upcomingEvents = [
      {
        source: "discord",
        discordId: "123",
        title: "Community night",
        startsAt: new Date(Date.UTC(2030, 6, 20, 19)),
        timezone: "UTC",
        location: "Online",
      },
    ];
    for (const session of [null, memberSession]) {
      const html = renderPage(baseData({ session, upcomingEvents }));
      expect(html).toContain("What’s on.");
      expect(html).toContain("Come along.");
      expect(html).toContain("Community night");
      const panel = html.split('<aside class="ember-home-panel"')[1]!.split("</aside>")[0]!;
      expect(panel).toContain(`<a href="${INVITE_URL}">Open Discord</a>`);
      expect(html).toContain(`href="${INVITE_URL}" data-testid="home-event-discord"`);
      expect(html).toContain("RSVP in Discord");
      expect(html).not.toContain("You’re in");
      expect(html).not.toContain("Pull me in");
    }
  });

  it("keeps the exact Hono title, canonical URL and JSON-LD marker", () => {
    const html = renderPage(baseData());
    expect(html).toContain("Together We Own — the lobby is open");
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/"`);
    expect(html).toContain('data-testid="site-jsonld"');
  });
});

describe("Kit home SSR render: one escaped structured-data block and one head identity", () => {
  it("emits exactly one site JSON-LD block that parses to the Organization and WebSite graph", () => {
    const html = renderPage(baseData({ session: memberSession }));
    const blocks = [...html.matchAll(JSON_LD_BLOCK)];
    expect(blocks.map((m) => m[1])).toEqual(["site-jsonld"]);
    const graph = JSON.parse(blocks[0]![2]!) as { "@graph": { "@type": string; "@id": string }[] };
    expect(graph["@graph"].map((node) => node["@type"])).toEqual(["Organization", "WebSite"]);
    expect(graph["@graph"][1]!["@id"]).toBe(`${APP_URL}/#website`);
  });

  it("renders one canonical link and one og:url in the head", () => {
    const html = renderPage(baseData());
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
    expect(html.match(/property="og:url"/g)).toHaveLength(1);
  });
});

function fullnessEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "canonical",
    eventKey: "game-night-1",
    title: "Game night",
    startsAt: new Date(Date.UTC(2030, 6, 20, 19, 0, 0)),
    timezone: "Europe/London",
    location: null,
    goingCount: 1,
    goingOccupancy: 1,
    capacity: 4,
    ...overrides,
  };
}

/** The one teaser row linking `key`, so a sibling's marker cannot satisfy the pin. */
function fullnessRow(html: string, key: string): string {
  const hit = [...html.matchAll(/<li class="card(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/li>/g)].find(
    ([row]) => row.includes(`/e/${key}"`),
  )?.[0];
  if (!hit) throw new Error(`no teaser row for ${key}`);
  return hit.split("</li>")[0]!;
}

describe("Kit home SSR render: member standing", () => {
  it("marks matching answers and highlights the earliest future own RSVP only for members", () => {
    const upcomingEvents = [
      fullnessEvent({ eventKey: "later", startsAt: new Date("2031-01-01T20:00:00Z") }),
      fullnessEvent({ eventKey: "first", startsAt: new Date("2030-01-01T20:00:00Z") }),
      fullnessEvent({ eventKey: "past", startsAt: new Date("2020-01-01T20:00:00Z") }),
      fullnessEvent({ eventKey: "not-going" }),
    ];
    const memberRsvps = [
      { eventKey: "later", status: "going" },
      { eventKey: "first", status: "waitlisted" },
      { eventKey: "past", status: "going" },
      { eventKey: "not-going", status: "not_going" },
    ];
    const html = renderPage(baseData({ session: memberSession, upcomingEvents, memberRsvps }));
    expect(fullnessRow(html, "later")).toContain("You're going.");
    expect(fullnessRow(html, "first")).toContain("You're on the waitlist.");
    expect(fullnessRow(html, "not-going")).not.toContain("home-event-own-rsvp");
    const standing = html.split('data-testid="home-standing"')[1]!.split("</section>")[0]!;
    expect(standing).toContain('href="/e/first"');
    expect(standing).toContain("You're on the waitlist.");
    expect(standing).not.toContain('href="/e/later"');
    const hero = html.split('<section class="hero')[1]!.split("</section>")[0]!;
    expect(hero).toContain("Your next RSVP:");
    expect(hero).toContain("You're on the waitlist.");
    expect(hero).toContain('href="/e/first"');
    for (const session of [null, nonMemberSession]) {
      const guestHtml = renderPage(baseData({ session, upcomingEvents, memberRsvps }));
      expect(guestHtml).not.toContain('data-testid="home-standing"');
      expect(guestHtml).not.toContain("home-event-own-rsvp");
      expect(guestHtml).not.toContain("Your next RSVP:");
    }
    expect(
      renderPage(baseData({ session: memberSession, upcomingEvents, memberRsvps: [] })),
    ).not.toContain('data-testid="home-standing"');
  });
});

describe("Kit home SSR render: teaser fullness verdict (owned pins)", () => {
  it("marks a teaser row full from occupancy even when the named count has room", () => {
    // One nameless going row holds the last seat: the verdict reads
    // occupancy, never the attributable count alone, so the Kit teaser
    // matches the Hono teaser, the card and the detail lineup.
    const html = renderPage(
      baseData({
        upcomingEvents: [fullnessEvent({ goingCount: 1, goingOccupancy: 2, capacity: 2 })],
      }),
    );
    const row = fullnessRow(html, "game-night-1");
    expect(row).toContain("1 of 2 going");
    expect(row).toContain('data-testid="event-spots-left"');
    expect(row).toContain(">Full<");
  });

  it("leaves an open capped teaser row unmarked: count only, no marker node", () => {
    // Kills the dropped-verdict mutant (capacity check without the >=
    // comparison renders "3 of 4 spots left" on this row), and the full
    // sibling proves the negative is scoped, not vacuous.
    const html = renderPage(
      baseData({
        upcomingEvents: [
          fullnessEvent({ eventKey: "open-night", goingCount: 1, goingOccupancy: 1, capacity: 4 }),
          fullnessEvent({ eventKey: "full-night", goingCount: 2, goingOccupancy: 2, capacity: 2 }),
        ],
      }),
    );
    expect(fullnessRow(html, "full-night")).toContain(">Full<");
    const row = fullnessRow(html, "open-night");
    expect(row).toContain("1 of 4 going");
    expect(row).not.toContain("event-spots-left");
  });

  it("renders trimmed details and one prioritized availability verdict", () => {
    const cases = [
      [{ endsAt: new Date(0), rsvpOpen: false, capacity: 1 }, "Ended"],
      [{ rsvpOpen: false, capacity: 1 }, "RSVPs paused"],
      [{ capacity: 1 }, "Full"],
      [{ capacity: 2 }, "1 seat left"],
      [{ capacity: 4 }, "3 seats left"],
      [{ capacity: null }, "No seat limit"],
    ] as const;
    for (const [fields, verdict] of cases) {
      const html = renderPage(
        baseData({
          session: memberSession,
          upcomingEvents: [
            fullnessEvent({
              game: "  Wingspan  ",
              organizer_name: "  Riley  ",
              location: "Table 2",
              ...fields,
            }),
          ],
        }),
      );
      const row = fullnessRow(html, "game-night-1");
      expect(row).toContain(">Wingspan</p>");
      expect(row).toContain('data-testid="event-card-host">Hosted by Riley</p>');
      expect(row.indexOf("Wingspan")).toBeLessThan(row.indexOf("Hosted by Riley"));
      expect(row.indexOf("Hosted by Riley")).toBeLessThan(row.indexOf("Table 2"));
      expect(row).toContain(`>${verdict}</span>`);
      expect(
        row.match(/data-testid="(?:event-schedule-availability|event-spots-left)"/g),
      ).toHaveLength(1);
    }
  });

  it("omits blank details and keeps Discord availability separate from seat math", () => {
    const html = renderPage(
      baseData({
        upcomingEvents: [
          fullnessEvent({ game: "  ", organizer_name: "  " }),
          {
            source: "discord",
            discordId: "123",
            title: "Discord night",
            startsAt: new Date(Date.UTC(2030, 6, 20, 19)),
            timezone: "UTC",
            location: null,
          },
        ],
      }),
    );
    const row = fullnessRow(html, "game-night-1");
    expect(row).not.toContain("event-card-host");
    expect(row).not.toContain("Game TBA");
    expect(html).toContain(
      'RSVP in Discord · <span data-testid="event-schedule-availability">Discord-managed</span>',
    );
  });

  it("falls back to the named count for older fixtures without occupancy", () => {
    // The live load always projects occupancy; hand-built rows predating it
    // keep the old verdict instead of crashing (the GoingCountState
    // occupancy precedent). The acceptance Kit suite relies on this.
    const { goingOccupancy: _dropped, ...older } = fullnessEvent({
      goingCount: 2,
      capacity: 2,
    });
    const html = renderPage(baseData({ upcomingEvents: [older] }));
    const row = fullnessRow(html, "game-night-1");
    expect(row).toContain("2 of 2 going");
    expect(row).toContain(">Full<");
  });
});
