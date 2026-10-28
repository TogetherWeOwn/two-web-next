import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { URL as NodeURL } from "node:url";
import { RsvpButton } from "../../src/events/rsvp-button";
import type { PublicEvent } from "../../src/events/reads";

const binder = readFileSync(
  new NodeURL("../../public/islands/rsvp-button.js", import.meta.url),
  "utf8",
);
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// A local DOM double for the shipped binder. Markup comes from the real SSR
// component; neither the actions nor the recovery notice are preconstructed.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes = new Map<string, string>();
  disabled = false;
  hidden = false;
  tagName = "";
  private text = "";
  listeners = new Map<string, (e: { preventDefault(): void }) => void>();
  get textContent(): string {
    return this.text + this.children.map((n) => n.textContent).join("");
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get href() {
    return this.getAttribute("href") ?? "";
  }
  set href(value: string) {
    this.setAttribute("href", value);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, String(value));
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  appendChild(node: Element) {
    node.parentNode = this;
    this.children.push(node);
    return node;
  }
  removeChild(node: Element) {
    this.children = this.children.filter((child) => child !== node);
    node.parentNode = null;
  }
  insertBefore(node: Element, anchor: Element) {
    if (node === anchor) return node;
    node.parentNode?.removeChild(node);
    node.parentNode = this;
    this.children.splice(this.children.indexOf(anchor), 0, node);
    return node;
  }
  replaceChild(next: Element, old: Element) {
    this.children[this.children.indexOf(old)] = next;
    next.parentNode = this;
    old.parentNode = null;
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  focus() {}
  contains(node: Element | null): boolean {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  addEventListener(type: string, listener: (e: { preventDefault(): void }) => void) {
    this.listeners.set(type, listener);
  }
  click() {
    if (!this.disabled) this.listeners.get("click")?.({ preventDefault() {} });
  }
  querySelectorAll(selector: string): Element[] {
    const matches = (node: Element) =>
      selector.split(",").some((part) => {
        const match = /^\[([^=\]]+)(?:="([^"]*)")?\]$/.exec(part.trim());
        if (!match) return node.tagName.toLowerCase() === part.trim().toLowerCase();
        return match[2] === undefined
          ? node.attributes.has(match[1]!)
          : node.getAttribute(match[1]!) === match[2];
      });
    return this.children.flatMap((node) => [
      ...(matches(node) ? [node] : []),
      ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

function parse(html: string) {
  const page = new Element();
  const stack = [page];
  const decode = (value: string) =>
    value
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  for (const token of html.match(/<[^>]*>|[^<]+/g) ?? []) {
    if (token.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (token.startsWith("<!")) continue;
    const node = stack[stack.length - 1]!.appendChild(new Element());
    if (!token.startsWith("<")) {
      node.textContent = decode(token);
      continue;
    }
    node.tagName = /^<([\w-]+)/.exec(token)![1]!;
    for (const [, key, value] of token.matchAll(/\s([\w-]+)(?:="([^"]*)")?/g))
      node.setAttribute(key!, decode(value ?? ""));
    if (!/^<(?:meta|link|input|br)\b/.test(token)) stack.push(node);
  }
  return page;
}

const event: PublicEvent = {
  id: 42,
  eventKey: KEY,
  title: "Fixture game night",
  game: null,
  description: null,
  startsAt: new Date("2030-01-01T20:00:00Z"),
  endsAt: new Date("2030-01-01T22:00:00Z"),
  timezone: "Europe/London",
  location: null,
  capacity: 4,
  goingCount: 1,
  goingOccupancy: 1,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2029-01-01"),
  updatedAt: new Date("2029-01-01"),
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
};

export function expiredRsvpBrowser(answer: "going" | null) {
  const page = parse(
    String(
      RsvpButton({
        e: event,
        member: true,
        answer: answer ? { status: answer, syncedToDiscordAt: null } : null,
        returnTo: `/e/${KEY}?attendees=2`,
        now: new Date("2029-01-01"),
      }),
    ),
  );
  const root = page.querySelector('[data-island="rsvp-button"]')!;
  const requests: { url: string; init: RequestInit; resolve(response: Response): void }[] = [];
  const broadcasts: unknown[] = [];
  const location = new URL(`https://next.example.test/e/${KEY}?attendees=2`);
  const document = {
    activeElement: null,
    querySelector: (selector: string) => page.querySelector(selector),
    querySelectorAll: (selector: string) => page.querySelectorAll(selector),
    createElement: (tagName: string) => Object.assign(new Element(), { tagName }),
    createTextNode: (text: string) => {
      const node = new Element();
      node.textContent = text;
      return node;
    },
    addEventListener() {},
    dispatchEvent: (event: unknown) => broadcasts.push(event),
  };
  runInNewContext(binder, {
    document,
    location,
    window: { document, location },
    URL,
    URLSearchParams,
    AbortController,
    CustomEvent: class {
      constructor(
        public type: string,
        public options: unknown,
      ) {}
    },
    fetch: (url: string, init: RequestInit) =>
      new Promise<Response>((resolve) => requests.push({ url, init, resolve })),
    setTimeout: () => 1,
    clearTimeout() {},
  });
  const settle = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  };
  return { root, requests, broadcasts, settle };
}
