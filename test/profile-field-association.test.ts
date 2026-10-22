// Profile validation field association. SSR: each field error
// exposes stable field/error ids, aria-invalid and associated error text;
// the server `games` key maps to the `games_text` control. Unknown/global
// errors stay in the summary without fabricated control associations.
// Island: the enhanced 422 path keeps field identity, links the summary to
// the matching control, and clears obsolete errors on accept/reset while
// honouring request ownership.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { jsx } from "hono/jsx";
import { describe, expect, it, vi } from "vitest";
import { ProfilePage } from "../src/profiles/pages";

const member = {
  id: "100000000000000001",
  username: "Fixture",
  avatar: null,
  bio: "Original bio",
  games: ["Chess"],
  timezone: "UTC",
};
const base = {
  member,
  isOwner: true as const,
  appUrl: "https://next.example.test",
};

const render = (
  errors: Record<string, string>,
  values = { bio: "draft bio", games_text: "Go", timezone: "UTC" },
): string => String(jsx(ProfilePage, { ...base, errors, values }));

describe("profile SSR field association", () => {
  it("bio error links the summary to the bio control with invalid state", () => {
    const html = render({ bio: "Keep your bio to 1000 characters or fewer." });
    expect(html).toContain('id="profile-bio"');
    expect(html).toContain('id="profile-bio-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(
      'aria-describedby="profile-bio-hint profile-bio-count profile-bio-error"',
    );
    expect(html).toContain('href="#profile-bio"');
    expect(html).toContain("Keep your bio to 1000 characters or fewer.");
  });

  it("server games key maps to the games_text control", () => {
    const html = render({ games: "Keep each game name to 80 characters or fewer." });
    expect(html).toContain('id="profile-games-text"');
    expect(html).toContain('id="profile-games-text-error"');
    expect(html).toContain(
      'aria-describedby="profile-games-text-hint profile-games-text-count profile-games-text-error"',
    );
    expect(html).toContain('href="#profile-games-text"');
    expect(html).toContain("Keep each game name to 80 characters or fewer.");
    expect(html).not.toContain('id="profile-games-error"');
  });

  it("timezone error links the summary to the timezone control", () => {
    const html = render({ timezone: "Choose a valid IANA timezone, e.g. Europe/London." });
    expect(html).toContain('id="profile-timezone"');
    expect(html).toContain('id="profile-timezone-error"');
    expect(html).toContain('href="#profile-timezone"');
  });

  it("inline errors sit after their label so the control's accessible name excludes them", () => {
    const html = render({
      bio: "Keep your bio to 1000 characters or fewer.",
      games: "Keep each game name to 80 characters or fewer.",
      timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
    });
    for (const id of ["profile-bio-error", "profile-games-text-error", "profile-timezone-error"]) {
      expect(html).toMatch(new RegExp(`</label><p id="${id}"`));
    }
  });

  it("unknown/global errors render safely without fabricated associations", () => {
    const html = render({
      fields: "Only your bio, games, timezone and leaderboard setting can be changed.",
    });
    expect(html).toContain(
      "Only your bio, games, timezone and leaderboard setting can be changed.",
    );
    expect(html).not.toContain('href="#profile-');
    expect(html).not.toContain("aria-invalid");
    expect(html).not.toContain("profile-bio-error");
    expect(html).not.toContain("profile-games-text-error");
    expect(html).not.toContain("profile-timezone-error");
  });

  it("error text is escaped and draft values are preserved", () => {
    const html = render(
      { bio: "<script>alert(1)</script>" },
      { bio: "<b>draft</b>", games_text: "<img>", timezone: "UTC" },
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;draft&lt;/b&gt;");
  });

  it("every describedby token resolves to a node id, with no duplicate ids", () => {
    const html = render({
      bio: "Bad bio.",
      games: "Bad games.",
      timezone: "Bad zone.",
      fields: "Global problem.",
    });
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]!);
    expect(new Set(ids).size).toBe(ids.length);
    const tokens = [...html.matchAll(/aria-describedby="([^"]+)"/g)].flatMap((m) =>
      m[1]!.split(/\s+/),
    );
    expect(tokens).toContain("profile-bio-error");
    expect(tokens).toContain("profile-games-text-error");
    expect(tokens).toContain("profile-timezone-error");
    for (const token of tokens) expect(ids, token).toContain(token);
  });
});

describe("profile island field association", () => {
  const binder = () => readFileSync("public/islands/member-profile.js", "utf8");
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  class Element {
    children: Element[] = [];
    parentNode: Element | null = null;
    attributes: Record<string, string> = {};
    listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
    hidden = false;
    href = "";
    value = "";
    defaultValue = "";
    private text = "";
    constructor(
      readonly tag: string,
      readonly document: { activeElement: Element | null },
    ) {}
    get textContent(): string {
      return this.text + this.children.map((child) => child.textContent).join("");
    }
    set textContent(value: string) {
      this.text = value;
      this.children = [];
    }
    get nextSibling(): Element | null {
      const siblings = this.parentNode?.children ?? [];
      return siblings[siblings.indexOf(this) + 1] ?? null;
    }
    setAttribute(key: string, value: string) {
      this.attributes[key] = value;
    }
    getAttribute(key: string) {
      return this.attributes[key] ?? null;
    }
    removeAttribute(key: string) {
      delete this.attributes[key];
    }
    appendChild(child: Element) {
      child.parentNode = this;
      this.children.push(child);
      return child;
    }
    insertBefore(child: Element, before: Element | null) {
      child.parentNode = this;
      if (before === null) this.children.push(child);
      else this.children.splice(this.children.indexOf(before), 0, child);
    }
    after(node: Element) {
      const parent = this.parentNode!;
      node.parentNode = parent;
      parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
    }
    remove() {
      if (this.parentNode)
        this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    }
    focus() {
      this.document.activeElement = this;
    }
    addEventListener(type: string, listener: (event: { preventDefault: () => void }) => void) {
      (this.listeners[type] ??= []).push(listener);
    }
    dispatch(type: string) {
      const event = { preventDefault: vi.fn() };
      this.listeners[type]?.forEach((listener) => listener(event));
      return event;
    }
    querySelectorAll(selector: string): Element[] {
      const attr = selector.match(/^\[([^=\^]+)(\^?=)["']([^"']*)["']\]$/);
      return this.children.flatMap((child) => {
        const matches = attr
          ? attr[2] === "^="
            ? child.getAttribute(attr[1]!)?.startsWith(attr[3]!)
            : child.getAttribute(attr[1]!) === attr[3]
          : child.tag === selector;
        return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
      });
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }

  function fixture() {
    const document = {
      activeElement: null as Element | null,
      createElement: (tag: string): Element => new Element(tag, document),
      createTextNode: (text: string): Element => {
        const node = new Element("#text", document);
        node.textContent = text;
        return node;
      },
      querySelector: (selector: string): Element | null => page.querySelector(selector),
    };
    const page = document.createElement("main");
    const node = (parent: Element, tag: string, testid?: string) => {
      const el = document.createElement(tag);
      if (testid) el.setAttribute("data-testid", testid);
      return parent.appendChild(el);
    };
    const root = node(page, "section", "profile-edit");
    root.setAttribute("data-island", "member-profile");
    root.setAttribute("data-member-id", "100000000000000001");
    const form = Object.assign(node(root, "form", "profile-form"), {
      elements: {} as Record<string, Element>,
    });
    for (const [key, tag] of [
      ["bio", "textarea"],
      ["games_text", "textarea"],
      ["timezone", "input"],
      ["website", "input"],
      ["formOpenedAt", "input"],
    ] as const) {
      const field = document.createElement(tag);
      field.value = field.defaultValue =
        key === "formOpenedAt" ? "1800000000000" : key === "timezone" ? "UTC" : "";
      const labelled = key === "bio" || key === "games_text" || key === "timezone";
      (labelled ? form.appendChild(document.createElement("label")) : form).appendChild(field);
      form.elements[key] = field;
    }
    const requests: {
      resolve: (r: { ok: boolean; status: number; json?: () => Promise<unknown> }) => void;
      reject: (e: Error) => void;
      promise: Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>;
    }[] = [];
    const fetch = vi.fn(() => {
      let resolve!: (r: { ok: boolean; status: number; json?: () => Promise<unknown> }) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<{ ok: boolean; status: number; json?: () => Promise<unknown> }>(
        (yes, no) => {
          resolve = yes;
          reject = no;
        },
      );
      requests.push({ resolve, reject, promise });
      return promise;
    });
    runInNewContext(binder(), {
      document,
      window: new EventTarget(),
      fetch,
      location: { pathname: "/members/100000000000000001", search: "" },
      setTimeout: (callback: () => void) => 0,
      Intl,
    });
    const byId = (id: string) => root.querySelector(`[id="${id}"]`);
    return { document, root, form, fetch, requests, byId };
  }

  it("server keyed errors associate with controls; games maps to games_text", async () => {
    const f = fixture();
    f.form.elements.bio!.value = "draft bio";
    f.form.elements.games_text!.value = "Go";
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({
        errors: {
          bio: "Keep your bio to 1000 characters or fewer.",
          games: "Keep each game name to 80 characters or fewer.",
          timezone: "Choose a valid IANA timezone, e.g. Europe/London.",
        },
      }),
    });
    await flush();
    for (const [, control, errorId] of [
      ["bio", "bio", "profile-bio-error"],
      ["games_text", "games_text", "profile-games-text-error"],
      ["timezone", "timezone", "profile-timezone-error"],
    ] as const) {
      const input = f.form.elements[control]!;
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")).toContain(errorId);
      expect(f.byId(errorId)?.textContent).toBeTruthy();
    }
    const summary = f.root.querySelector('[data-testid="profile-error"]');
    expect(summary?.getAttribute("role")).toBe("alert");
    const links = summary?.querySelectorAll("a") ?? [];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#profile-bio",
      "#profile-games-text",
      "#profile-timezone",
    ]);
    // Draft values are untouched by the association wiring.
    expect(f.form.elements.bio!.value).toBe("draft bio");
    expect(f.form.elements.games_text!.value).toBe("Go");
  });

  it("unknown errors stay in the summary with no fabricated association", async () => {
    const f = fixture();
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({
        errors: {
          fields: "Only your bio, games, timezone and leaderboard setting can be changed.",
        },
      }),
    });
    await flush();
    const summary = f.root.querySelector('[data-testid="profile-error"]');
    expect(summary?.textContent).toContain(
      "Only your bio, games, timezone and leaderboard setting can be changed.",
    );
    expect(summary?.querySelector("a")).toBeNull();
    for (const control of ["bio", "games_text", "timezone"])
      expect(f.form.elements[control]!.getAttribute("aria-invalid")).toBeNull();
    expect(f.byId("profile-bio-error")).toBeNull();
  });

  it("summary-link keyboard activation focuses the control without changing values", async () => {
    const f = fixture();
    f.form.elements.bio!.value = "keep me";
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: "Keep your bio to 1000 characters or fewer." } }),
    });
    await flush();
    const summary = f.root.querySelector('[data-testid="profile-error"]')!;
    const link = summary.querySelector("a")!;
    expect(link.getAttribute("href")).toBe("#profile-bio");
    // Synthetic keyboard: focus the link, then activate it as Enter would.
    link.focus();
    expect(f.document.activeElement).toBe(link);
    link.dispatch("click");
    expect(f.document.activeElement).toBe(f.form.elements.bio);
    expect(f.form.elements.bio!.value).toBe("keep me");
  });

  it("server text stays literal and bounded", async () => {
    const f = fixture();
    const evil = "<img src=x onerror=alert(1)>" + "y".repeat(600);
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: evil } }),
    });
    await flush();
    const errorNode = f.byId("profile-bio-error")!;
    expect(errorNode.textContent.length).toBeLessThanOrEqual(500);
    expect(errorNode.querySelector("img")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')?.querySelector("img")).toBeNull();
  });

  it("control-character client error links the summary to the field it names", () => {
    const f = fixture();
    f.form.elements.bio!.value = "a\u0001b";
    f.form.dispatch("submit");
    const summary = f.root.querySelector('[data-testid="profile-error"]')!;
    expect(summary.querySelector("a")!.getAttribute("href")).toBe("#profile-bio");
    expect(f.form.elements.bio!.getAttribute("aria-invalid")).toBe("true");
    expect(f.byId("profile-bio-error")).not.toBeNull();
    expect(f.requests).toHaveLength(0);
  });

  it("inline error is inserted beside its label, never inside it", async () => {
    const f = fixture();
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: "Bad bio." } }),
    });
    await flush();
    const label = f.form.elements.bio!.parentNode!;
    const inline = f.byId("profile-bio-error")!;
    expect(inline.parentNode).toBe(label.parentNode);
    expect(label.children).not.toContain(inline);
  });

  it("two client errors on one field keep both messages inline", () => {
    const f = fixture();
    const games = ["g".repeat(81), ...Array.from({ length: 21 }, (_, i) => `game ${i}`)];
    f.form.elements.games_text!.value = games.join("\n");
    f.form.dispatch("submit");
    const inline = f.byId("profile-games-text-error")!;
    expect(inline.textContent).toContain("Keep each game name to 80 characters or fewer.");
    expect(inline.textContent).toContain("Add no more than 20 games.");
  });

  it("accept clears obsolete field errors; reset clears them explicitly", async () => {
    const f = fixture();
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: "Bad bio." } }),
    });
    await flush();
    expect(f.byId("profile-bio-error")).not.toBeNull();
    f.form.dispatch("submit");
    f.requests[1]!.resolve({ ok: true, status: 200, json: async () => ({ saved: true }) });
    await flush();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.form.elements.bio!.getAttribute("aria-invalid")).toBeNull();

    f.form.dispatch("submit");
    f.requests[2]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { timezone: "Bad zone." } }),
    });
    await flush();
    expect(f.byId("profile-timezone-error")).not.toBeNull();
    f.form.dispatch("reset");
    f.form.elements.timezone!.value = f.form.elements.timezone!.defaultValue;
    await flush();
    expect(f.byId("profile-timezone-error")).toBeNull();
    expect(f.form.elements.timezone!.getAttribute("aria-invalid")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
  });

  it("a late validation error after cancel cannot restore stale field errors", async () => {
    const f = fixture();
    f.form.elements.bio!.value = "Old invalid write";
    f.form.dispatch("submit");
    const pending = f.requests[0]!;
    f.form.dispatch("reset");
    f.form.elements.bio!.value = f.form.elements.bio!.defaultValue;
    pending.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: "Old validation error" } }),
    });
    await flush();
    await flush();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
  });
});
