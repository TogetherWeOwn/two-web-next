import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { jsx } from "hono/jsx";
import { describe, expect, it, vi } from "vitest";
import { ProfilePage } from "../src/profiles/pages";

const binder = readFileSync("public/islands/member-profile.js", "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type ResponseFixture = { ok: boolean; status: number; type?: string; json?: () => Promise<unknown> };
const success = () => ({ ok: true, status: 200 });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only the DOM surface used by the shipped binder. Network and reset timers
// are explicitly completed by each test; no browser, clock or live DB needed.
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
  constructor(readonly tag: string, readonly document: { activeElement: Element | null }) {}
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(""); }
  set textContent(value: string) { this.text = value; this.children = []; }
  setAttribute(key: string, value: string) { this.attributes[key] = value; }
  getAttribute(key: string) { return this.attributes[key] ?? null; }
  appendChild(child: Element) { child.parentNode = this; this.children.push(child); return child; }
  insertBefore(child: Element, before: Element) {
    child.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, child);
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  focus() { this.document.activeElement = this; }
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
        ? attr[2] === "^=" ? child.getAttribute(attr[1]!)?.startsWith(attr[3]!) : child.getAttribute(attr[1]!) === attr[3]
        : child.tag === selector;
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

function fixture(search = "") {
  const document = {
    activeElement: null as Element | null,
    createElement: (tag: string): Element => new Element(tag, document),
    createTextNode: (text: string): Element => { const node = new Element("#text", document); node.textContent = text; return node; },
    querySelector: (selector: string): Element | null => page.querySelector(selector),
  };
  const page = document.createElement("main");
  const node = (parent: Element, tag: string, testid?: string, text?: string) => {
    const el = document.createElement(tag);
    if (testid) el.setAttribute("data-testid", testid);
    if (text) el.textContent = text;
    return parent.appendChild(el);
  };
  const name = node(page, "h1", "profile-name", "Fixture member");
  const bio = node(page, "p", "profile-bio", "Original bio");
  const games = node(page, "div", "profile-games");
  node(games, "ul").appendChild(document.createTextNode("Chess"));
  const timezone = node(page, "p", "profile-timezone", "Timezone: UTC");
  const root = node(page, "section", "profile-edit");
  root.setAttribute("data-island", "member-profile");
  root.setAttribute("data-member-id", "100000000000000001");
  const heading = node(root, "h2");
  heading.setAttribute("id", "edit-heading");
  const editControl = node(root, "div", "profile-edit-control");
  editControl.hidden = true;
  const edit = node(editControl, "button", "profile-edit-again", "Edit your profile");
  const form = Object.assign(node(root, "form", "profile-form"), {
    elements: Object.fromEntries(Object.entries({ bio: "Original bio", games_text: "Chess", timezone: "UTC", website: "", formOpenedAt: "1800000000000", _method: "PATCH" }).map(([key, value]) => {
      const field = node(root.querySelector("form")!, key === "bio" || key === "games_text" ? "textarea" : "input");
      field.value = field.defaultValue = value;
      return [key, field];
    })) as Record<string, Element>,
  });
  const requests: ReturnType<typeof deferred<ResponseFixture>>[] = [];
  const fetch = vi.fn(() => { const request = deferred<ResponseFixture>(); requests.push(request); return request.promise; });
  const timers: (() => void)[] = [];
  const window = new EventTarget();
  runInNewContext(binder, { document, window, fetch, location: { pathname: "/members/100000000000000001", search }, setTimeout: (callback: () => void) => timers.push(callback), Intl });
  const enter = (values: Partial<Record<"bio" | "games_text" | "timezone", string>>) => {
    for (const [key, value] of Object.entries(values)) form.elements[key]!.value = value;
  };
  const cancel = () => {
    form.dispatch("reset");
    Object.values(form.elements).forEach((field) => { field.value = field.defaultValue; });
    timers.splice(0).forEach((callback) => callback());
  };
  const notice = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  return { document, window, root, name, heading, bio, games, timezone, form, edit, editControl, fetch, requests, enter, cancel, notice };
}

describe("shipped member-profile edit lifecycle", () => {
  it("supports two saves, re-edit and cancel to the latest accepted values without reloading", async () => {
    const f = fixture();
    f.enter({ bio: "First bio", games_text: "Go\nChess", timezone: "Europe/London" });
    expect(f.form.dispatch("submit").preventDefault).toHaveBeenCalledOnce();
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.form.hidden).toBe(true);
    expect(f.editControl.hidden).toBe(false);
    expect(f.bio.textContent).toBe("First bio");
    expect(f.games.querySelectorAll("li").map((li) => li.textContent)).toEqual(["Go", "Chess"]);
    expect(f.timezone.textContent).toBe("Timezone: Europe/London");
    expect(f.document.activeElement).toBe(f.notice("profile-saved"));
    f.edit.dispatch("click");
    expect(f.form.hidden).toBe(false);
    expect(f.editControl.hidden).toBe(true);
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.document.activeElement).toBe(f.heading);
    f.enter({ bio: "Second bio", games_text: "  Go  \nGo\n\nChess ", timezone: "" });
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("Second bio");
    expect(f.games.querySelectorAll("li").map((li) => li.textContent)).toEqual(["Go", "Chess"]);
    expect(f.timezone.hidden).toBe(true);
    f.edit.dispatch("click");
    f.enter({ bio: "Discard me", games_text: "Other", timezone: "Asia/Tokyo" });
    f.cancel();
    expect(f.form.elements.bio!.value).toBe("Second bio");
    expect(f.form.elements.games_text!.value).toBe("Go\nChess");
    expect(f.form.elements.timezone!.value).toBe("");
    expect(f.form.hidden).toBe(false);
    expect(f.document.activeElement).toBe(f.name);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.bio.textContent).toBe("Second bio");
  });

  it.each(["success", "validation", "server", "network"] as const)("ignores late %s after cancelling a pending save", async (outcome) => {
    const f = fixture();
    f.enter({ bio: "Cancelled write" });
    f.form.dispatch("submit");
    f.cancel();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    if (outcome === "network") f.requests[0]!.reject(new Error("offline"));
    else f.requests[0]!.resolve(outcome === "success" ? success() : { ok: false, status: outcome === "validation" ? 422 : 500, json: async () => ({ errors: { bio: "Rejected" } }) });
    await flush();
    expect(f.form.hidden).toBe(false);
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.editControl.hidden).toBe(true);
    for (const id of ["profile-saved", "profile-error", "profile-save-failed"]) expect(f.notice(id)).toBeNull();
    expect(f.document.activeElement).toBe(f.name);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each(["success", "network"] as const)("does not let cancelled %s unlock or replace a newer pending save", async (outcome) => {
    const f = fixture();
    f.enter({ bio: "Old write" });
    f.form.dispatch("submit");
    f.cancel();
    f.enter({ bio: "New write" });
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    if (outcome === "network") f.requests[0]!.reject(new Error("offline"));
    else f.requests[0]!.resolve(success());
    await flush();
    expect(f.form.elements.bio!.value).toBe("New write");
    expect(f.form.hidden).toBe(false);
    expect(f.notice("profile-saved")).toBeNull();
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("New write");
    f.edit.dispatch("click");
    f.cancel();
    expect(f.form.elements.bio!.value).toBe("New write");
  });

  it("ignores delayed validation JSON after cancel and a newer successful save", async () => {
    const f = fixture();
    const json = deferred<unknown>();
    f.enter({ bio: "Old invalid write" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve({ ok: false, status: 422, json: () => json.promise });
    await flush();
    f.cancel();
    f.enter({ bio: "Accepted" });
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    const saved = f.notice("profile-saved");
    json.resolve({ errors: { bio: "Old validation error" } });
    await flush();
    expect(f.notice("profile-error")).toBeNull();
    expect(f.notice("profile-saved")).toBe(saved);
    expect(f.bio.textContent).toBe("Accepted");
    expect(f.document.activeElement).toBe(saved);
  });

  it.each(["validation", "network", "server"] as const)("keeps input and allows retry after %s failure", async (outcome) => {
    const f = fixture();
    f.enter({ bio: "Keep this draft", games_text: "Go" });
    f.form.dispatch("submit");
    if (outcome === "network") f.requests[0]!.reject(new Error("offline"));
    else f.requests[0]!.resolve({ ok: false, status: outcome === "validation" ? 422 : 503, json: async () => ({ errors: { bio: "Bio rejected" } }) });
    await flush();
    const alert = f.notice(outcome === "validation" ? "profile-error" : "profile-save-failed");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(alert);
    expect(f.form.hidden).toBe(false);
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
    expect(f.form.elements.bio!.defaultValue).toBe("Original bio");
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.notice("profile-error")).toBeNull();
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.bio.textContent).toBe("Keep this draft");
  });

  it("keeps a newer draft typed during save, then resets to the accepted snapshot", async () => {
    const f = fixture();
    f.enter({ bio: "  Accepted bio  ", games_text: "Chess\n Go ", timezone: "" });
    f.form.dispatch("submit");
    f.enter({ bio: "Newer unsaved draft" });
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.form.hidden).toBe(false);
    expect(f.editControl.hidden).toBe(true);
    expect(f.form.elements.bio!.value).toBe("Newer unsaved draft");
    expect(f.bio.textContent).toBe("Accepted bio");
    f.cancel();
    expect(f.form.elements.bio!.value).toBe("Accepted bio");
    expect(f.form.elements.games_text!.value).toBe("Chess\nGo");
    expect(f.notice("profile-saved")).toBeNull();
  });

  it("renders cleared values and literal text without interpreting HTML", async () => {
    const f = fixture();
    f.enter({ bio: "<b>literal</b>", games_text: "<img onerror=oops>", timezone: "UTC" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("<b>literal</b>");
    expect(f.bio.querySelector("b")).toBeNull();
    expect(f.games.querySelector("li")?.textContent).toBe("<img onerror=oops>");
    expect(f.games.querySelector("img")).toBeNull();
    f.edit.dispatch("click");
    f.enter({ bio: "   ", games_text: "\n\r\n", timezone: "" });
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("No bio yet.");
    expect(f.games.textContent).toBe("No games listed yet.");
    expect(f.games.querySelector("ul")).toBeNull();
    expect(f.timezone.hidden).toBe(true);
    f.edit.dispatch("click");
    expect(f.form.elements.bio!.value).toBe("");
    expect(f.form.elements.games_text!.value).toBe("");
  });

  it.each([401, 419, 302, 0])("keeps expiry durable after response %s, blocks repeat PATCHes and preserves every draft field until reset", async (status) => {
    const f = fixture("?edit=1&tab=games");
    const draft = { bio: "  Keep this draft  ", games_text: " Go \nChess\nGo", timezone: "Asia/Tokyo" };
    f.enter(draft);
    f.form.dispatch("submit");
    f.requests[0]!.resolve({ ok: false, status, type: status === 0 ? "opaqueredirect" : "basic" });
    await flush();
    const expired = f.notice("profile-session-expired")!;
    expect(expired.getAttribute("role")).toBe("alert");
    expect(expired.textContent).toContain("Your session expired. Your changes are still here.");
    expect(expired.querySelector("a")?.href).toBe(`/auth/recover?next=${encodeURIComponent("/members/100000000000000001?edit=1&tab=games")}`);
    expect(f.document.activeElement).toBe(expired);
    f.edit.dispatch("click");
    expect(f.notice("profile-session-expired")).toBe(expired);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(f.form.dispatch("submit").preventDefault).toHaveBeenCalledOnce();
      expect(f.notice("profile-session-expired")?.getAttribute("role")).toBe("alert");
      expect(f.document.activeElement).toBe(f.notice("profile-session-expired"));
    }
    expect(f.root.querySelectorAll('[data-testid="profile-session-expired"]')).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.form.hidden).toBe(false);
    for (const [key, value] of Object.entries(draft)) expect(f.form.elements[key]!.value).toBe(value);
    expect(f.form.elements.bio!.defaultValue).toBe("Original bio");
    expect(f.form.elements.games_text!.defaultValue).toBe("Chess");
    expect(f.form.elements.timezone!.defaultValue).toBe("UTC");
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.games.textContent).toBe("Chess");
    expect(f.timezone.textContent).toBe("Timezone: UTC");
    expect(f.notice("profile-saved")).toBeNull();

    f.cancel();
    expect(f.notice("profile-session-expired")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.form.elements.games_text!.value).toBe("Chess");
    expect(f.form.elements.timezone!.value).toBe("UTC");
    expect(f.document.activeElement).toBe(f.name);
    expect(f.fetch).toHaveBeenCalledOnce();
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.notice("profile-saved")?.getAttribute("role")).toBe("status");
  });

  it("handles a cancelable window expiry event locally without sending or losing the draft", () => {
    const f = fixture("?tab=games");
    const draft = { bio: "Event-expired draft", games_text: "Go\nChess", timezone: "Europe/London" };
    f.enter(draft);
    const event = new Event("two:session-expired", { cancelable: true });
    // Native dispatch returns false when this island handles the global notice.
    expect(f.window.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    const expired = f.notice("profile-session-expired")!;
    expect(expired.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(expired);
    expect(expired.querySelector("a")?.href).toBe(`/auth/recover?next=${encodeURIComponent("/members/100000000000000001?tab=games")}`);
    f.edit.dispatch("click");
    expect(f.notice("profile-session-expired")).toBe(expired);
    f.form.dispatch("submit");
    f.form.dispatch("submit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.root.querySelectorAll('[data-testid="profile-session-expired"]')).toHaveLength(1);
    for (const [key, value] of Object.entries(draft)) expect(f.form.elements[key]!.value).toBe(value);
    expect(f.form.hidden).toBe(false);
    f.cancel();
    expect(f.notice("profile-session-expired")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.form.elements.games_text!.value).toBe("Chess");
    expect(f.form.elements.timezone!.value).toBe("UTC");
    expect(f.fetch).not.toHaveBeenCalled();
  });

  it("keeps client validation and the submitted request contract intact", () => {
    const f = fixture();
    f.enter({ bio: "x".repeat(1001) });
    f.form.dispatch("submit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.notice("profile-error")?.textContent).toContain("1000 characters");
    f.enter({ bio: "<b>literal</b>", games_text: "Chess\nGo", timezone: "UTC" });
    f.form.dispatch("submit");
    expect(f.notice("profile-error")).toBeNull();
    expect(f.fetch).toHaveBeenCalledExactlyOnceWith("/members/100000000000000001", {
      method: "PATCH", headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "same-origin", redirect: "manual",
      body: JSON.stringify({ bio: "<b>literal</b>", games_text: "Chess\nGo", timezone: "UTC", website: "", formOpenedAt: 1800000000000 }),
    });
  });

  it("preserves the visible no-JS POST form and hides enhancement-only re-edit control", () => {
    const html = jsx(ProfilePage, { member: { id: "100000000000000001", username: "Fixture", avatar: null, bio: "Original bio", games: ["Chess"], timezone: "UTC" }, isOwner: true, appUrl: "https://next.example.test" }).toString();
    expect(html).toMatch(/<form method="post" action="\/members\/100000000000000001" data-testid="profile-form">/);
    expect(html).toContain('name="_method" value="PATCH"');
    // Hide the unstyled wrapper: .btn's display:inline-flex overrides the
    // browser's hidden rule if hidden is put on the styled button itself.
    expect(html).toMatch(/<div data-testid="profile-edit-control" hidden=""><button class="btn" type="button" data-testid="profile-edit-again">/);
    expect(html).toContain('data-testid="profile-bio"');
    expect(html).toContain('data-testid="profile-games"');
    expect(html).toContain('data-testid="profile-timezone"');
    expect(html).toContain('name="website"');
    expect(html).toContain('name="formOpenedAt"');
    expect(html).toContain('type="reset" data-testid="profile-cancel"');
    const viewer = jsx(ProfilePage, { member: { id: "100000000000000001", username: "Fixture", avatar: null, bio: null, games: [], timezone: null }, isOwner: false, appUrl: "https://next.example.test" }).toString();
    expect(viewer).not.toContain('data-testid="profile-edit-again"');
  });
});
