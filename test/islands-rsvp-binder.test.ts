// Execute the shipped binder without a browser, network or database.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RsvpButton } from "../src/events/rsvp-button";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { RSVP_COPY, RSVP_UNKNOWN_TESTID, RSVP_REFRESH_TESTID } from "../src/islands/contracts";

const binder = readFileSync(new NodeURL("../public/islands/rsvp-button.js", import.meta.url), "utf8");
class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  focused = false;
  href = "";
  private text = "";
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  get textContent(): string { return this.text + this.children.map((n) => n.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  setAttribute(k: string, v: string) { this.attributes.set(k, String(v)); }
  getAttribute(k: string) { return this.attributes.get(k) ?? null; }
  removeAttribute(k: string) { this.attributes.delete(k); }
  appendChild(n: Node) { n.parentNode = this; this.children.push(n); return n; }
  removeChild(n: Node) { this.children = this.children.filter((child) => child !== n); n.parentNode = null; }
  replaceChild(next: Node, old: Node) { this.children[this.children.indexOf(old)] = next; next.parentNode = this; old.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  focus() { this.focused = true; }
  addEventListener(type: string, fn: (e: { preventDefault: () => void }) => void) { this.listeners.set(type, fn); }
  click() { if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} }); }
  querySelectorAll(selector: string): Node[] {
    const matches = (n: Node) => selector.split(",").some((s) => {
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);
      return m ? (m[2] === undefined ? n.attributes.has(m[1]!) : n.getAttribute(m[1]!) === m[2]) : false;
    });
    return this.children.flatMap((n) => [...(matches(n) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
// Small parser for trusted JSX fixture markup, not a second hand-written action set.
function parse(html: string) {
  const page = new Node(); const stack = [page];
  const decode = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) { stack.pop(); continue; }
    if (token.startsWith("<!")) continue;
    const n = new Node(); stack[stack.length - 1]!.appendChild(n);
    if (!token.startsWith("<")) { n.textContent = decode(token); continue; }
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g)) n.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(n);
  }
  return page;
}
const event: PublicEvent = {
  id: 42, eventKey: "raid/one", title: "Squad night", game: null, description: null,
  startsAt: new Date("2030-01-01T20:00:00Z"), endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "Europe/London", location: null, capacity: 4, goingCount: 1, status: "published",
  discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
  createdBy: null, rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
  recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
  createdAt: new Date(), updatedAt: new Date(), icsSequence: 0n,
};
function browser(state: "open" | "going" | "going-full" | "waitlisted" | "closed" | "full" = "open", loginUrl = "/join/discord?next=%2Fe%2Fraid%2Fone", integrated = false, overrides: Partial<PublicEvent> = {}) {
  const e = { ...event, status: state === "closed" ? "cancelled" : "published", goingCount: state === "full" || state === "going-full" ? 4 : 1, ...overrides };
  const props = { e, member: true, answer: state === "going" || state === "going-full" || state === "waitlisted" ? { status: state === "going-full" ? "going" : state, syncedToDiscordAt: null } : null,
    returnTo: "/e/raid/one", now: new Date("2029-01-01") };
  const html = integrated ? String(EventPage({ ...props, neighbors: { previous: null, next: null }, related: [],
    attendees: [{ id: "member-one", name: "One" }], appUrl: "https://next.example.test", jsonLd: "{}" })) : String(RsvpButton(props));
  const page = parse(html);
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  root.setAttribute("data-login-url", loginUrl);
  const requests: { url: string; init: RequestInit; resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  let reloads = 0;
  const listeners = new Map<string, (event: { type: string; detail: unknown }) => void>();
  const context = {
    document: {
      querySelector: (selector: string) => page.querySelector(selector),
      querySelectorAll: (selector: string) => page.querySelectorAll(selector),
      createElement: () => new Node(),
      createTextNode: (text: string) => { const n = new Node(); n.textContent = text; return n; },
      addEventListener: (type: string, fn: (event: { type: string; detail: unknown }) => void) => listeners.set(type, fn),
      dispatchEvent: (event: { type: string; detail: unknown }) => { broadcasts.push(event); listeners.get(event.type)?.(event); },
    },
    CustomEvent: class { constructor(public type: string, public options: { detail: unknown }) {} get detail() { return this.options.detail; } },
    location: { pathname: "/e/raid/one", reload: () => { reloads++; } },
    fetch: (url: string, init: RequestInit) => new Promise<Response>((resolve, reject) => requests.push({ url, init, resolve, reject })),
  };
  if (integrated) runInNewContext(readFileSync(new NodeURL("../public/islands/going-count.js", import.meta.url), "utf8"), context);
  runInNewContext(binder, context);
  const get = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const finish = (i: number, status: number, body: unknown = { data: { status: "going", synced_to_discord_at: null } }, headers?: HeadersInit) =>
    requests[i]!.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers }));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const emit = (type: string, detail: unknown) => context.document.dispatchEvent({ type, detail });
  return { root, page, html, get, requests, broadcasts, finish, settle, emit, reloads: () => reloads };
}

describe("RsvpButton shipped binder", () => {
  it.each([403, 409])("handles a %i JSON outcome instead of losing it after headers arrive", async (status) => {
    const b = browser(); b.get("rsvp-going")!.click();
    b.finish(0, status, status === 403 ? { error: "rsvp_closed" } : { error: "event_full", capacity: 7 });
    await b.settle();
    if (status === 403) expect(b.reloads()).toBe(1);
    else expect(b.get("event-full")?.textContent).toBe("This one's full. Cap is 7.");
    expect(b.root.getAttribute("aria-busy")).toBeNull();
    expect(b.root.querySelectorAll("[data-action]").every((n) => !n.disabled)).toBe(true);
  });

  it("does not reload a forbidden response", async () => {
    const b = browser(); b.get("rsvp-going")!.click(); b.finish(0, 403, { error: "forbidden" }); await b.settle();
    expect(b.reloads()).toBe(0);
    expect(b.get("rsvp-failed")?.getAttribute("role")).toBe("alert");
  });

  it("sends one PUT, paints confirmation, broadcasts the contract payload and does no re-read", async () => {
    const b = browser(); expect(b.requests).toHaveLength(0);
    b.get("rsvp-going")!.click();
    expect(b.requests).toHaveLength(1);
    expect(b.requests[0]).toMatchObject({ url: "/events/raid%2Fone/rsvp", init: { method: "PUT", body: '{"status":"going"}', credentials: "same-origin", redirect: "manual" } });
    expect(b.root.getAttribute("aria-busy")).toBe("true");
    expect(b.get("rsvp-going")!.textContent).toBe("Saving…");
    b.finish(0, 201); await b.settle();
    expect(b.get("rsvp-confirmed")?.textContent).toBe("✓ You're in");
    expect(b.get("rsvp-confirmed")?.focused).toBe(true);
    expect(b.get("rsvp-withdraw")?.disabled).toBe(false);
    expect(b.get("rsvp-syncing")?.textContent).toBe("Saved. Syncing to Discord.");
    expect(b.broadcasts.map(({ type, detail }) => ({ type, detail }))).toEqual([{ type: "going-count-updated", detail: { eventKey: "raid/one", viewerState: "going" } }]);
    expect(b.requests).toHaveLength(1);
  });

  it("suppresses a disabled double-click instead of aborting a server write", async () => {
    const b = browser(); const button = b.get("rsvp-going")!;
    button.click(); button.click();
    expect(b.requests).toHaveLength(1); expect(b.requests[0]!.init.signal).toBeUndefined();
    b.finish(0, 201); await b.settle();
    expect(b.get("rsvp-failed")).toBeNull(); expect(b.broadcasts).toHaveLength(1);
  });

  it("prevents reversed server commits by blocking conflicting intent until settlement", async () => {
    const b = browser("waitlisted"); const leave = b.get("waitlist-leave")!;
    let stored = "waitlisted";
    b.get("waitlist-claim")!.click(); leave.click();
    // The earlier PUT can still commit even if a transport were cancelled.
    // There is no later DELETE to run ahead of it, and no abort signal.
    expect(leave.disabled).toBe(true); expect(b.requests).toHaveLength(1);
    expect(b.requests[0]!.init.signal).toBeUndefined();
    stored = "going"; b.finish(0, 200, { data: { status: stored, synced_to_discord_at: null } }); await b.settle();
    expect(b.get("rsvp-confirmed")).not.toBeNull();
    b.get("rsvp-withdraw")!.click(); stored = "none"; b.finish(1, 204); await b.settle();
    expect(stored).toBe("none"); expect(b.get("rsvp-going")).not.toBeNull();
    expect(b.broadcasts.map((e) => e.detail)).toEqual([
      { eventKey: "raid/one", viewerState: "going" }, { eventKey: "raid/one", viewerState: "none" },
    ]);
  });

  it("DELETE clears the answer and emits none without a follow-up request", async () => {
    const b = browser("going"); b.get("rsvp-withdraw")!.click();
    expect(b.requests[0]!.init.method).toBe("DELETE"); expect(b.requests[0]!.init.body).toBeUndefined();
    b.finish(0, 204); await b.settle();
    expect(b.get("rsvp-confirmed")).toBeNull(); expect(b.get("rsvp-withdraw")).toBeNull();
    expect(b.get("rsvp-going")?.focused).toBe(true);
    expect(b.broadcasts[0]!.detail).toEqual({ eventKey: "raid/one", viewerState: "none" });
    expect(b.requests).toHaveLength(1);
  });

  it("claims the waitlist without stale controls", async () => {
    const b = browser("waitlisted"); b.get("waitlist-claim")!.click(); b.finish(0, 200); await b.settle();
    expect(b.requests[0]!.init.body).toBe('{"status":"going"}');
    expect(b.get("waitlist-position")).toBeNull(); expect(b.get("waitlist-leave")).toBeNull();
    expect(b.get("rsvp-confirmed")).not.toBeNull();
    expect(b.broadcasts[0]!.detail).toEqual({ eventKey: "raid/one", viewerState: "going" });
  });

  it("removes the old claim when the locked server keeps a claimant waitlisted", async () => {
    const b = browser("waitlisted"); expect(b.get("waitlist-claim")).not.toBeNull();
    b.get("waitlist-claim")!.click();
    b.finish(0, 200, { data: { status: "waitlisted", waitlist_position: 2 } }); await b.settle();
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("waitlist-claim")).toBeNull();
    expect(b.get("waitlist-position")?.textContent).toBe("You're on the waitlist — #2 in line");
    expect(b.broadcasts[0]!.detail).toEqual({ eventKey: "raid/one", viewerState: "waitlisted" });
    b.get("waitlist-leave")!.click(); expect(b.requests[1]!.init.method).toBe("DELETE");
    b.finish(1, 204); await b.settle();
    expect(b.get("waitlist-join")).not.toBeNull(); expect(b.get("rsvp-going")).toBeNull();
  });

  it("transitions actual open SSR to a usable waitlist action after a capacity conflict", async () => {
    const b = browser(); expect(b.get("waitlist-join")).toBeNull();
    b.get("rsvp-going")!.click(); b.finish(0, 409, { capacity: 4 }); await b.settle();
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("rsvp-going")).toBeNull();
    b.get("waitlist-join")!.click(); b.finish(1, 201, { data: { status: "waitlisted", waitlist_position: 3 } }); await b.settle();
    expect(b.requests[1]!.init.body).toBe('{"status":"waitlisted"}');
    expect(b.get("waitlist-position")?.textContent).toBe("You're on the waitlist — #3 in line");
    expect(b.get("waitlist-claim")).toBeNull();
  });

  it("honors the current FIFO server's waitlisted answer to a going request", async () => {
    const b = browser(); b.get("rsvp-going")!.click();
    b.finish(0, 201, { data: { status: "waitlisted", waitlist_position: 2 } }); await b.settle();
    expect(b.get("rsvp-confirmed")).toBeNull();
    expect(b.get("waitlist-position")?.textContent).toBe("You're on the waitlist — #2 in line");
    expect(b.broadcasts[0]!.detail).toEqual({ eventKey: "raid/one", viewerState: "waitlisted" });
  });

  it.each([[1, "1 second"], [5, "5 seconds"], [null, null]])("uses CM throttle copy for Retry-After %s and permits retry", async (seconds, text) => {
    const b = browser(); const button = b.get("rsvp-going")!; button.click();
    b.finish(0, 429, {}, seconds === null ? {} : { "Retry-After": String(seconds) }); await b.settle();
    expect(b.get("rsvp-rate-limited")?.textContent).toBe(text
      ? `Slow down — try again in ${text}. Nothing changed, just wait a moment.`
      : "Slow down — try again in a moment. Nothing changed, just wait a bit.");
    expect(b.get("rsvp-rate-limited")?.getAttribute("role")).toBe("status");
    expect(b.get("rsvp-rate-limited")?.focused).toBe(false); expect(button.disabled).toBe(false);
    expect(b.broadcasts).toHaveLength(0); button.click(); expect(b.requests).toHaveLength(2);
  });

  it.each([401, 419, 302])("uses the SSR return link on expired-session status %i", async (status) => {
    const b = browser(); b.get("rsvp-going")!.click(); b.finish(0, status); await b.settle();
    const notice = b.get("rsvp-session-expired")!;
    expect(notice.getAttribute("role")).toBe("alert"); expect(notice.focused).toBe(true);
    expect(notice.children[1]!.href).toBe("/join/discord?next=%2Fe%2Fraid%2Fone");
    expect(b.get("rsvp-going")!.disabled).toBe(false); expect(b.broadcasts).toHaveLength(0);
  });

  it.each([
    ["javascript:alert(1)", "/join/discord?next=%2Fe%2Fraid%2Fone"],
    ["https://evil.example.test/phish", "/join/discord?next=%2Fe%2Fraid%2Fone"],
    ["", "/join/discord?next=%2Fe%2Fraid%2Fone"],
    ["/join/discord?next=%2Fe%2Fother", "/join/discord?next=%2Fe%2Fother"],
    ["/join/discord", "/join/discord"],
  ])("never assigns hostile mount text %s to the login href (falls back or keeps contract shape)", async (raw, expected) => {
    const b = browser("open", raw); b.get("rsvp-going")!.click(); b.finish(0, 401); await b.settle();
    expect(b.get("rsvp-session-expired")!.children[1]!.href).toBe(expected);
  });

  it.each(["network", "500", "422"])("announces %s failure without stealing focus or disabling retry", async (kind) => {
    const b = browser(); const button = b.get("rsvp-going")!; button.click();
    if (kind === "network") b.requests[0]!.reject(new Error("offline")); else b.finish(0, Number(kind));
    await b.settle();
    expect(b.get("rsvp-failed")?.textContent).toBe("That RSVP didn't save. Try once more.");
    expect(b.get("rsvp-failed")?.focused).toBe(false); expect(button.disabled).toBe(false);
    expect(b.root.getAttribute("aria-busy")).toBeNull(); expect(b.broadcasts).toHaveLength(0);
  });

  it("keeps full copy and does not offer a seat claim after joining a full waitlist", async () => {
    const b = browser("full"); b.get("waitlist-join")!.click(); b.finish(0, 201, { data: { status: "waitlisted", waitlist_position: 1 } }); await b.settle();
    expect(b.get("event-full")?.textContent).toBe("This one's full. Cap is 4.");
    expect(b.get("waitlist-claim")).toBeNull(); expect(b.get("waitlist-leave")).not.toBeNull();
  });

  it("a paused holder can leave without reopening joins or claims", async () => {
    const b = browser("waitlisted"); b.root.setAttribute("data-paused", "true");
    b.get("waitlist-leave")!.click(); b.finish(0, 204); await b.settle();
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0);
    expect(b.get("waitlist-position")).toBeNull();
  });

  it("keeps every conflicting control disabled through response-body parsing", async () => {
    const b = browser("waitlisted"); let resolveBody!: (body: unknown) => void;
    b.get("waitlist-claim")!.click();
    b.requests[0]!.resolve({ ok: true, status: 200,
      json: () => new Promise<unknown>((resolve) => { resolveBody = resolve; }),
    } as Response); await b.settle();
    const leave = b.get("waitlist-leave")!;
    expect(leave.disabled).toBe(true); leave.click();
    // Programmatic submit cannot bypass the lock either.
    b.root.querySelector("[data-rsvp-form]")!.listeners.get("submit")!({ preventDefault() {} });
    expect(b.requests).toHaveLength(1);
    resolveBody({ data: { status: "going", synced_to_discord_at: null } }); await b.settle();
    expect(b.get("rsvp-confirmed")).not.toBeNull(); expect(b.broadcasts).toHaveLength(1);
  });

  it("integrates EventPage SSR and both binders: one aggregate GET, count and announcement update", async () => {
    const b = browser("open", undefined, true);
    expect(b.html.match(/src="\/islands\/going-count\.js"/g)).toHaveLength(1);
    expect(b.html).toContain('data-testid="event-attendees-refresh"');
    expect(b.requests).toHaveLength(0);
    b.get("rsvp-going")!.click(); b.finish(0, 201); await b.settle();
    expect(b.requests).toHaveLength(2); expect(b.requests[1]!.url).toBe("/events.json?event_key=raid%2Fone");
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 2 }]); await b.settle();
    const badge = b.page.querySelector('[data-island="going-count"]')!;
    expect(badge.querySelector("[data-count]")?.textContent).toBe("2 of 4 going");
    expect(badge.querySelector("[data-announcement]")?.textContent).toBe("You're going. ");
    expect(b.requests).toHaveLength(2);
  });

  it.each([
    ["unreadable JSON", "not json"],
    ["missing data", "{}"],
    ["missing status", '{"data":{"synced_to_discord_at":null}}'],
    ["null status", '{"data":{"status":null}}'],
    ["invalid status", '{"data":{"status":"bogus"}}'],
    ["unexpected non-seat answer", '{"data":{"status":"maybe"}}'],
  ])("offers honest recovery instead of claiming a seat for %s success", async (_, body) => {
    const b = browser(); const button = b.get("rsvp-going")!; button.click();
    b.requests[0]!.resolve(new Response(body, { status: 201 })); await b.settle();
    expect(b.get("rsvp-confirmed")).toBeNull(); expect(b.get("rsvp-syncing")).toBeNull();
    expect(b.get(RSVP_UNKNOWN_TESTID)?.getAttribute("role")).toBe("alert");
    expect(b.get(RSVP_UNKNOWN_TESTID)?.textContent).toBe(`${RSVP_COPY.unknown} ${RSVP_COPY.refresh}`);
    expect(b.get(RSVP_REFRESH_TESTID)?.href).toBe("/e/raid%2Fone");
    expect(b.root.getAttribute("aria-busy")).toBeNull(); expect(button.disabled).toBe(true);
    expect(b.broadcasts).toHaveLength(0); button.click();
    b.root.querySelector("[data-rsvp-form]")!.listeners.get("submit")!({ preventDefault() {} });
    expect(b.requests).toHaveLength(1);
  });

  it.each([202, 204])("does not infer a PUT answer from unexpected success status %i", async (status) => {
    const b = browser(); b.get("rsvp-going")!.click(); b.finish(0, status); await b.settle();
    expect(b.get("rsvp-confirmed")).toBeNull(); expect(b.get("rsvp-unknown")).not.toBeNull();
    expect(b.broadcasts).toHaveLength(0); expect(b.requests).toHaveLength(1);
  });

  it("does not infer withdrawal from a non-contract success response", async () => {
    const b = browser("going"); b.get("rsvp-withdraw")!.click(); b.finish(0, 200); await b.settle();
    expect(b.get("rsvp-confirmed")).not.toBeNull(); expect(b.get("rsvp-going")).toBeNull();
    expect(b.get("rsvp-unknown")).not.toBeNull(); expect(b.broadcasts).toHaveLength(0);
  });

  it("keeps the newest aggregate when withdrawal GET B finishes before join GET A", async () => {
    const b = browser("open", undefined, true); b.get("rsvp-going")!.click(); b.finish(0, 201); await b.settle();
    expect(b.requests[1]!.url).toBe("/events.json?event_key=raid%2Fone");
    b.get("rsvp-withdraw")!.click(); b.finish(2, 204); await b.settle();
    expect(b.requests[3]!.url).toBe("/events.json?event_key=raid%2Fone");
    b.finish(3, 200, [{ event_key: "raid/one", going_count: 1, capacity: 4 }]); await b.settle();
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 2, capacity: 4 }]); await b.settle();
    const badge = b.page.querySelector('[data-island="going-count"]')!;
    expect(badge.querySelector("[data-count]")?.textContent).toBe("1 of 4 going");
    expect(badge.querySelector("[data-announcement]")?.textContent).toBe("RSVP removed. ");
    expect(b.broadcasts.filter((e) => e.type === "going-count-refreshed").map((e) => e.detail)).toEqual([
      { eventKey: "raid/one", goingCount: 1, capacity: 4 },
    ]);
    expect(b.requests).toHaveLength(4);
  });

  it("does not invent a vacancy when withdrawing promotes a FIFO waiter into the full event", async () => {
    const b = browser("going-full", undefined, true); b.get("rsvp-withdraw")!.click(); b.finish(0, 204); await b.settle();
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("rsvp-going")).toBeNull();
    expect(b.get("waitlist-join")).not.toBeNull(); expect(b.requests[1]!.url).toBe("/events.json?event_key=raid%2Fone");
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 4, capacity: 4 }]); await b.settle();
    expect(b.get("event-full")?.textContent).toBe("This one's full. Cap is 4.");
    expect(b.get("rsvp-going")).toBeNull(); expect(b.get("waitlist-claim")).toBeNull();
    expect(b.page.querySelector("[data-count]")?.textContent).toBe("4 of 4 going");
    b.get("waitlist-join")!.click(); expect(b.requests[2]!.init.body).toBe('{"status":"waitlisted"}');
    expect(b.requests).toHaveLength(3);
  });

  it.each([4, null])("offers going only after a fresh allocation shows room (capacity %s)", async (capacity) => {
    const b = browser("going-full", undefined, true); b.get("rsvp-withdraw")!.click(); b.finish(0, 204); await b.settle();
    expect(b.get("rsvp-going")).toBeNull();
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 3, capacity }]); await b.settle();
    expect(b.root.getAttribute("data-full")).toBe("false"); expect(b.get("event-full")).toBeNull();
    const badge = b.page.querySelector('[data-island="going-count"]')!;
    expect(badge.getAttribute("data-capacity")).toBe(capacity === null ? "" : "4");
    expect(badge.querySelector("[data-spots]")!.hidden).toBe(capacity === null);
    if (capacity !== null) expect(badge.querySelector("[data-spots]")!.textContent).toBe("1 of 4 spots left");
    expect(b.get("waitlist-join")).toBeNull(); b.get("rsvp-going")!.click();
    expect(b.requests[2]!.init.body).toBe('{"status":"going"}'); expect(b.requests).toHaveLength(3);
  });

  it("keeps the last capacity when the post-withdrawal aggregate fails", async () => {
    const b = browser("going-full", undefined, true); b.get("rsvp-withdraw")!.click(); b.finish(0, 204); await b.settle();
    b.finish(1, 500); await b.settle();
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("rsvp-going")).toBeNull();
    expect(b.get("waitlist-join")).not.toBeNull(); expect(b.requests).toHaveLength(2);
  });

  it("reconciles claim availability without guessing the viewer's FIFO position", async () => {
    const b = browser("full", undefined, true); b.get("waitlist-join")!.click();
    b.finish(0, 201, { data: { status: "waitlisted", waitlist_position: 3 } }); await b.settle();
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 3, capacity: 4 }]); await b.settle();
    expect(b.get("waitlist-position")?.textContent).toBe("You're on the waitlist — #3 in line");
    expect(b.get("waitlist-claim")).not.toBeNull(); expect(b.get("event-full")).toBeNull();
    b.emit("going-count-refreshed", { eventKey: "raid/one", goingCount: 4, capacity: 4 });
    expect(b.get("waitlist-claim")).toBeNull(); expect(b.get("waitlist-leave")).not.toBeNull();
    expect(b.requests).toHaveLength(2);
  });

  it("does not reopen actual paused SSR after withdrawal and a fresh allocation", async () => {
    const b = browser("waitlisted", undefined, true, { rsvpOpen: false });
    expect(b.get("waitlist-claim")).toBeNull(); b.get("waitlist-leave")!.click(); b.finish(0, 204); await b.settle();
    b.finish(1, 200, [{ event_key: "raid/one", going_count: 1, capacity: 4 }]); await b.settle();
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0);
    expect(b.get("rsvp-paused")).not.toBeNull(); expect(b.requests).toHaveLength(2);
  });

  it("ignores nonmatching/malformed allocations and snapshots during a write or unknown outcome", async () => {
    const b = browser("full");
    for (const detail of [
      { eventKey: "other", goingCount: 0, capacity: 4 },
      { eventKey: "raid/one", goingCount: -1, capacity: 4 },
      { eventKey: "raid/one", goingCount: 0, capacity: "4" },
    ]) b.emit("going-count-refreshed", detail);
    expect(b.get("rsvp-going")).toBeNull(); expect(b.get("waitlist-join")).not.toBeNull();
    b.get("waitlist-join")!.click();
    b.emit("going-count-refreshed", { eventKey: "raid/one", goingCount: 0, capacity: 4 });
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("waitlist-join")?.disabled).toBe(true);
    b.requests[0]!.resolve({ ok: true, status: 201, json() { throw new Error("unreadable"); } } as unknown as Response);
    await b.settle();
    b.emit("going-count-refreshed", { eventKey: "raid/one", goingCount: 0, capacity: 4 });
    expect(b.root.getAttribute("data-full")).toBe("true"); expect(b.get("rsvp-unknown")).not.toBeNull();
    expect(b.get("waitlist-join")?.disabled).toBe(true); expect(b.requests).toHaveLength(1);
  });

  it("does not create member controls in closed SSR after a capacity snapshot", () => {
    const b = browser("closed"); b.emit("going-count-refreshed", { eventKey: "raid/one", goingCount: 0, capacity: 4 });
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0); expect(b.get("rsvp-closed")).not.toBeNull();
    expect(b.requests).toHaveLength(0);
  });

  it("closed SSR has no click action or load-time request", () => {
    const b = browser("closed"); expect(b.requests).toHaveLength(0);
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0);
    expect(binder).not.toMatch(/setInterval|setTimeout|window\.confirm|website/);
  });
});
