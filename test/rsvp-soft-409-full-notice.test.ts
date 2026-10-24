// A raced fill (PUT 409) from a soft answer flips the change control to the
// waitlist join without painting the full notice SSR omits for soft answers.
// Same fixture-DOM recipe as islands-rsvp-binder.test.ts, fed with the REAL
// soft SSR so a wrong server render fails here too.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { describe, expect, it } from "vitest";
import { RsvpButton } from "../src/events/rsvp-button";
import type { PublicEvent, ViewerRsvp } from "../src/events/reads";

const binder = readFileSync(
  new NodeURL("../public/islands/rsvp-button.js", import.meta.url),
  "utf8",
);

class Node {
  children: Node[] = [];
  parentNode: Node | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  focused = false;
  private text = "";
  listeners = new Map<string, (e: { preventDefault: () => void }) => void>();
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  setAttribute(k: string, v: string) {
    this.attributes.set(k, String(v));
  }
  getAttribute(k: string) {
    return this.attributes.get(k) ?? null;
  }
  removeAttribute(k: string) {
    this.attributes.delete(k);
  }
  appendChild(n: Node) {
    n.parentNode = this;
    this.children.push(n);
    return n;
  }
  insertBefore(n: Node, anchor: Node) {
    if (n === anchor) return n;
    if (n.parentNode) n.parentNode.children = n.parentNode.children.filter((c) => c !== n);
    n.parentNode = this;
    this.children.splice(this.children.indexOf(anchor), 0, n);
    return n;
  }
  removeChild(n: Node) {
    this.children = this.children.filter((child) => child !== n);
    n.parentNode = null;
  }
  replaceChild(next: Node, old: Node) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  focus() {
    this.focused = true;
  }
  contains(node: Node | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, fn: (e: { preventDefault: () => void }) => void) {
    this.listeners.set(type, fn);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): Node[] {
    const matches = (n: Node) =>
      selector.split(",").some((s) => {
        const m = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(s.trim());
        return m
          ? m[2] === undefined
            ? n.attributes.has(m[1]!)
            : n.getAttribute(m[1]!) === m[2]
          : false;
      });
    return this.children.flatMap((n) => [
      ...(matches(n) ? [n] : []),
      ...n.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

// Single-pass entity decode: one replace call, so a decoded `&` can never be
// re-unescaped by a later pass (CodeQL js/double-escaping).
const ENTITIES: Record<string, string> = {
  "&#39;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};
const decode = (s: string): string =>
  s.replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, (m) => ENTITIES[m]!);

function parse(html: string): Node {
  const page = new Node();
  const stack = [page];
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const n = new Node();
    stack[stack.length - 1]!.appendChild(n);
    if (!token.startsWith("<")) {
      n.textContent = decode(token);
      continue;
    }
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      n.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(n);
  }
  return page;
}

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PATH = `/e/${KEY}`;

function hydrate(answer: ViewerRsvp | null) {
  const e: PublicEvent = {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Squad night",
    game: null,
    description: null,
    startsAt: new Date("2030-01-10T20:00:00Z"),
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 1,
    goingOccupancy: 1,
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
    createdAt: new Date("2030-01-01T00:00:00Z"),
    updatedAt: new Date("2030-01-01T00:00:00Z"),
    syncRevision: 1,
    syncedRevision: 0,
  };
  const html = String(RsvpButton({ e, member: true, answer, returnTo: PATH }));
  const page = parse(html);
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  const requests: { url: string; init: RequestInit; resolve: (r: Response) => void }[] = [];
  runInNewContext(binder, {
    document: {
      querySelector: (s: string) => page.querySelector(s),
      querySelectorAll: (s: string) => page.querySelectorAll(s),
      createElement: () => new Node(),
      createTextNode: (text: string) => {
        const n = new Node();
        n.textContent = text;
        return n;
      },
      addEventListener: () => {},
      dispatchEvent: () => {},
    },
    CustomEvent: class {
      constructor(
        public type: string,
        public options: { detail: unknown },
      ) {}
      get detail() {
        return this.options.detail;
      }
    },
    location: { pathname: PATH, reload: () => {} },
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ url, init, resolve })),
    setTimeout: ((callback: () => void) => 0) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout,
  });
  return {
    root,
    requests,
    get: (id: string) => root.querySelector(`[data-testid="${id}"]`),
    settle: async () => {
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function put409(b: ReturnType<typeof hydrate>, action: string) {
  b.root.querySelector(`[data-action="${action}"]`)!.click();
  expect(b.requests).toHaveLength(1);
  expect(b.requests[0]!.init.method).toBe("PUT");
  b.requests[0]!.resolve(
    new Response(JSON.stringify({ capacity: 10 }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  );
  await b.settle();
}

describe("409 from a soft answer keeps the neutral branch", () => {
  it.each(["maybe", "not_going"] as const)(
    "%s change raced by a fill flips to waitlist join with no full notice",
    async (status) => {
      const b = hydrate({ status, syncedToDiscordAt: null });
      expect(b.get(status === "maybe" ? "rsvp-maybe" : "rsvp-not-going")).not.toBeNull();
      await put409(b, "going");
      expect(b.get("event-full")).toBeNull();
      const join = b.get("waitlist-join");
      expect(join).not.toBeNull();
      expect(join!.getAttribute("data-action")).toBe("waitlisted");
      expect(join!.getAttribute("value")).toBe("waitlisted");
      expect(join!.focused).toBe(true);
      expect(b.root.getAttribute("data-full")).toBe("true");
      expect(b.get(status === "maybe" ? "rsvp-maybe" : "rsvp-not-going")).not.toBeNull();
      expect(b.get("rsvp-withdraw")).not.toBeNull();
    },
  );

  it("unanswered 409 still paints the full notice (control)", async () => {
    const b = hydrate(null);
    await put409(b, "going");
    const full = b.get("event-full");
    expect(full).not.toBeNull();
    expect(full!.textContent).toContain("Cap is 10.");
    expect(full!.focused).toBe(true);
    expect(b.get("waitlist-join")).not.toBeNull();
  });
});
