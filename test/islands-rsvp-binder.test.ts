// Execute the shipped binder without a browser, network or database.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";

const binder = readFileSync(new NodeURL("../public/islands/rsvp-button.js", import.meta.url), "utf8");
class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  disabled = false;
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
  click() { this.listeners.get("click")?.({ preventDefault() {} }); }
  querySelectorAll(selector: string): Node[] {
    const matches = (n: Node) => selector.split(",").some((s) => {
      const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s);
      return m ? (m[2] === undefined ? n.attributes.has(m[1]!) : n.getAttribute(m[1]!) === m[2]) : false;
    });
    return this.children.flatMap((n) => [...(matches(n) ? [n] : []), ...n.querySelectorAll(selector)]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}
function node(testid: string, text: string, action?: string) {
  const n = new Node(); n.setAttribute("data-testid", testid); n.textContent = text;
  if (action) n.setAttribute("data-action", action);
  return n;
}
function browser(state: "open" | "going" | "waitlisted" | "closed" | "full" = "open") {
  const root = new Node();
  root.setAttribute("data-event-key", "raid/one");
  root.setAttribute("data-login-url", "/auth/discord?next=%2Fe%2Fraid%2Fone");
  root.setAttribute("data-capacity", "4");
  root.setAttribute("data-full", state === "full" ? "true" : "false");
  root.setAttribute("data-paused", "false");
  if (state === "full") {
    root.appendChild(node("event-full", "This one's full. Cap is 4."));
    root.appendChild(node("waitlist-join", "Join the waitlist", "waitlisted"));
  } else if (state === "open") {
    root.appendChild(node("rsvp-going", "I'm in", "going"));
    root.appendChild(node("waitlist-join", "Join the waitlist", "waitlisted"));
  } else if (state === "going") {
    root.appendChild(node("rsvp-confirmed", "You're in"));
    root.appendChild(node("rsvp-withdraw", "Can't make it", "withdraw"));
  } else if (state === "waitlisted") {
    root.appendChild(node("waitlist-position", "You're on the waitlist"));
    root.appendChild(node("waitlist-claim", "A seat opened up — I'm in", "going"));
    root.appendChild(node("waitlist-leave", "Leave the waitlist", "withdraw"));
  } else root.appendChild(node("rsvp-closed", "Cancelled"));
  const requests: { url: string; init: RequestInit; resolve: (r: Response) => void; reject: (e: Error) => void }[] = [];
  const broadcasts: { type: string; detail: unknown }[] = [];
  let reloads = 0;
  runInNewContext(binder, {
    AbortController,
    document: {
      querySelector: () => root,
      createElement: () => new Node(),
      createTextNode: (text: string) => { const n = new Node(); n.textContent = text; return n; },
      dispatchEvent: (event: { type: string; detail: unknown }) => broadcasts.push(event),
    },
    CustomEvent: class { constructor(public type: string, public options: { detail: unknown }) {} get detail() { return this.options.detail; } },
    location: { pathname: "/e/raid/one", reload: () => { reloads++; } },
    fetch: (url: string, init: RequestInit) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })),
  });
  const get = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const finish = (i: number, status: number, body: unknown = { data: { synced_to_discord_at: null } }, headers?: HeadersInit) =>
    requests[i]!.resolve(new Response(status === 204 ? null : JSON.stringify(body), { status, headers }));
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return { root, get, requests, broadcasts, finish, settle, reloads: () => reloads };
}

describe("RsvpButton shipped binder", () => {
  it.each([403, 409])("handles a %i JSON outcome instead of losing it after headers arrive", async (status) => {
    const b = browser(); b.get("rsvp-going")!.click();
    b.finish(0, status, status === 403 ? { error: "rsvp_closed" } : { error: "event_full", capacity: 7 });
    await b.settle();
    if (status === 403) expect(b.reloads()).toBe(1);
    else expect(b.get("event-full")?.textContent).toBe("This one's full. Cap is 7.");
    expect(b.root.getAttribute("aria-busy")).toBeNull();
    expect(b.get("rsvp-going")!.disabled).toBe(false);
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

  it("aborts and resends, ignoring a superseded response", async () => {
    const b = browser(); const button = b.get("rsvp-going")!;
    button.click(); button.click();
    expect(b.requests).toHaveLength(2); expect(b.requests[0]!.init.signal!.aborted).toBe(true);
    b.finish(1, 200); await b.settle(); b.finish(0, 500); await b.settle();
    expect(b.get("rsvp-failed")).toBeNull(); expect(b.broadcasts).toHaveLength(1);
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

  it("joins then claims the waitlist without stale controls", async () => {
    const b = browser(); b.get("waitlist-join")!.click(); b.finish(0, 201); await b.settle();
    expect(b.requests[0]!.init.body).toBe('{"status":"waitlisted"}');
    expect(b.get("waitlist-position")?.textContent).toBe("You're on the waitlist");
    expect(b.get("waitlist-position")?.focused).toBe(true);
    b.get("waitlist-claim")!.click(); b.finish(1, 200); await b.settle();
    expect(b.get("waitlist-position")).toBeNull(); expect(b.get("waitlist-leave")).toBeNull();
    expect(b.get("rsvp-confirmed")).not.toBeNull();
    expect(b.broadcasts.map((e) => e.detail)).toEqual([
      { eventKey: "raid/one", viewerState: "waitlisted" }, { eventKey: "raid/one", viewerState: "going" },
    ]);
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
    expect(notice.children[1]!.href).toBe("/auth/discord?next=%2Fe%2Fraid%2Fone");
    expect(b.get("rsvp-going")!.disabled).toBe(false); expect(b.broadcasts).toHaveLength(0);
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
    const b = browser("full"); b.get("waitlist-join")!.click(); b.finish(0, 201); await b.settle();
    expect(b.get("event-full")?.textContent).toBe("This one's full. Cap is 4.");
    expect(b.get("waitlist-claim")).toBeNull(); expect(b.get("waitlist-leave")).not.toBeNull();
  });

  it("a paused holder can leave without reopening joins or claims", async () => {
    const b = browser("waitlisted"); b.root.setAttribute("data-paused", "true");
    b.get("waitlist-leave")!.click(); b.finish(0, 204); await b.settle();
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0);
    expect(b.get("waitlist-position")).toBeNull();
  });

  it("superseding with a different action restores the first control even if abort is ignored", async () => {
    const b = browser(); const going = b.get("rsvp-going")!;
    going.click(); b.get("waitlist-join")!.click();
    expect(going.disabled).toBe(false); expect(going.textContent).toBe("I'm in");
    b.finish(1, 500); await b.settle(); b.finish(0, 201); await b.settle();
    expect(going.disabled).toBe(false); expect(b.broadcasts).toHaveLength(0);
  });

  it("ignores a stale success body that resolves after a newer response", async () => {
    const b = browser(); let resolveBody!: (body: unknown) => void;
    b.get("rsvp-going")!.click();
    const response = new Response("{}", { status: 201 });
    response.json = () => new Promise((resolve) => { resolveBody = resolve; });
    b.requests[0]!.resolve(response); await b.settle();
    b.get("waitlist-join")!.click(); b.finish(1, 200); await b.settle();
    resolveBody({ data: { status: "going", synced_to_discord_at: null } }); await b.settle();
    expect(b.get("rsvp-confirmed")).toBeNull(); expect(b.get("waitlist-position")).not.toBeNull();
    expect(b.broadcasts).toHaveLength(1);
  });

  it("closed SSR has no click action or load-time request", () => {
    const b = browser("closed"); expect(b.requests).toHaveLength(0);
    expect(b.root.querySelectorAll("[data-action]")).toHaveLength(0);
    expect(binder).not.toMatch(/setInterval|setTimeout|window\.confirm|website/);
  });
});
