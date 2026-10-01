import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  PROFILE_COPY,
  PROFILE_SAVE_DEADLINE_MS,
  PROFILE_UNCERTAIN_TESTID,
} from "../src/islands/contracts";

const binder = readFileSync("public/islands/member-profile.js", "utf8");

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

type ResponseFixture = { ok: boolean; status: number; type?: string; json?: () => Promise<unknown> };
const success = () => ({ ok: true, status: 200 });
const flush = async (rounds = 5) => {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

// Same DOM surface as the shipped binder lifecycle suite, plus a controllable
// timer queue: the save deadline is the only long timer, so tests advance it
// explicitly instead of waiting on wall-clock time.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  hidden = false;
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

interface Timer { id: number; cb: () => void; ms: number }

function fixture(abortable: boolean) {
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
  const requests: (ReturnType<typeof deferred<ResponseFixture>> & { url: string; init: { signal?: AbortSignal } })[] = [];
  const fetch = vi.fn((url: string, init: { signal?: AbortSignal } = {}) => {
    const request = deferred<ResponseFixture>();
    requests.push({ url, init, ...request });
    // Behave like a real fetch: aborting the owned controller rejects.
    init.signal?.addEventListener("abort", () => request.reject(Object.assign(new Error("Save aborted"), { name: "AbortError" })), { once: true });
    return request.promise;
  });
  const timers: Timer[] = [];
  let timerSeq = 0;
  let elapsed = 0;
  const setTimeout = (cb: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.push({ id, cb, ms: elapsed + ms });
    return id;
  };
  const clearTimeout = (id: number) => {
    const at = timers.findIndex((t) => t.id === id);
    if (at >= 0) timers.splice(at, 1);
  };
  const sandbox: Record<string, unknown> = {
    document, fetch, location: { pathname: "/members/100000000000000001" }, setTimeout, clearTimeout, Intl,
  };
  if (abortable) sandbox.AbortController = AbortController;
  runInNewContext(binder, sandbox);
  const enter = (values: Partial<Record<"bio" | "games_text" | "timezone", string>>) => {
    for (const [key, value] of Object.entries(values)) form.elements[key]!.value = value;
  };
  const cancel = () => {
    form.dispatch("reset");
    Object.values(form.elements).forEach((field) => { field.value = field.defaultValue; });
    // The reset handler must have disposed the owned deadline timer already;
    // only the focus timer may remain for the drain below.
    expect(timers.every((t) => t.ms - elapsed < PROFILE_SAVE_DEADLINE_MS)).toBe(true);
    timers.splice(0).forEach((t) => t.cb());
  };
  const advance = (ms: number) => {
    elapsed += ms;
    timers.filter((t) => t.ms <= elapsed).sort((a, b) => a.id - b.id).forEach((t) => {
      const at = timers.indexOf(t);
      if (at >= 0) timers.splice(at, 1);
      t.cb();
    });
  };
  const notice = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const uncertain = () => notice(PROFILE_UNCERTAIN_TESTID);
  return { document, root, name, bio, form, edit, editControl, fetch, requests, timers, enter, cancel, advance, notice, uncertain };
}

describe("member-profile save deadline", () => {
  it("pins a finite owned deadline shared by the contract and the binder", () => {
    expect(Number.isFinite(PROFILE_SAVE_DEADLINE_MS)).toBe(true);
    expect(PROFILE_SAVE_DEADLINE_MS).toBeGreaterThan(0);
    const binderMs = Number(binder.match(/SAVE_DEADLINE_MS\s*=\s*(\d+)/)?.[1]);
    expect(binderMs).toBe(PROFILE_SAVE_DEADLINE_MS);
    expect(PROFILE_COPY.uncertain.length).toBeGreaterThan(0);
    expect(binder).toContain(PROFILE_COPY.uncertain);
    expect(binder).toContain(PROFILE_UNCERTAIN_TESTID);
  });

  it("keeps a single PATCH with no signal where AbortController is unavailable", () => {
    const f = fixture(false);
    f.enter({ bio: "Keep this draft" });
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.requests[0]!.init.signal).toBeUndefined();
    expect(f.requests[0]!.url).toBe("/members/100000000000000001");
  });

  it.each([true, false])("shows bounded uncertain feedback at the deadline with the draft intact (abortable=%s)", async (abortable) => {
    const f = fixture(abortable);
    const focusedBefore = f.document.activeElement;
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.enter({ bio: "Hung write plus newer typing" });
    f.advance(PROFILE_SAVE_DEADLINE_MS - 1);
    await flush();
    expect(f.uncertain()).toBeNull();
    f.advance(1);
    await flush();
    const el = f.uncertain();
    expect(el?.getAttribute("role")).toBe("status");
    expect(el?.textContent).toContain(PROFILE_COPY.uncertain);
    expect(el?.textContent.length).toBeGreaterThan(0);
    // Draft intact, form still open, single PATCH sent, no focus theft.
    expect(f.form.elements.bio!.value).toBe("Hung write plus newer typing");
    expect(f.form.hidden).toBe(false);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.document.activeElement).toBe(focusedBefore);
  });

  it("never represents the timeout as a server rollback", async () => {
    const f = fixture(true);
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    const text = f.uncertain()?.textContent ?? "";
    expect(text).not.toMatch(/rollback|rolled back|reverted|was not saved|did not save|failed/i);
    expect(text).toMatch(/may still have gone through/i);
  });

  it("ignores the late success after an aborted deadline without touching the baseline", async () => {
    const f = fixture(true);
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    // The owned controller aborted the hung fetch; its rejection settles here.
    expect(f.requests[0]!.init.signal?.aborted).toBe(true);
    expect(f.uncertain()).not.toBeNull();
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.form.elements.bio!.defaultValue).toBe("Original bio");
  });

  it("ignores a late success that arrives without an abort controller", async () => {
    const f = fixture(false);
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    expect(f.uncertain()).not.toBeNull();
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.form.elements.bio!.defaultValue).toBe("Original bio");
  });

  it("ignores delayed validation JSON after the deadline", async () => {
    const f = fixture(false);
    const json = deferred<unknown>();
    f.enter({ bio: "Old invalid write" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve({ ok: false, status: 422, json: () => json.promise });
    await flush();
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    json.resolve({ errors: { bio: "Old validation error" } });
    await flush();
    expect(f.notice("profile-error")).toBeNull();
    expect(f.uncertain()).not.toBeNull();
    expect(f.bio.textContent).toBe("Original bio");
  });

  it("recovers ordinary controls after the deadline without resending on its own", async () => {
    const f = fixture(true);
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    // A retry is a new user action: it sends exactly one PATCH and settles.
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.uncertain()).toBeNull();
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.notice("profile-saved")).not.toBeNull();
    expect(f.bio.textContent).toBe("Hung write");
  });

  it("lets a newer post-deadline save own feedback against the late first write", async () => {
    const f = fixture(false);
    f.enter({ bio: "First write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    f.enter({ bio: "Second write" });
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    const saved = f.notice("profile-saved");
    expect(saved).not.toBeNull();
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.notice("profile-saved")).toBe(saved);
    expect(f.bio.textContent).toBe("Second write");
  });

  it("leaves no timers behind a fast successful save", async () => {
    const f = fixture(true);
    f.enter({ bio: "Fast write" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.notice("profile-saved")).not.toBeNull();
    expect(f.uncertain()).toBeNull();
    expect(f.timers).toHaveLength(0);
    expect(f.requests[0]!.init.signal?.aborted).toBe(false);
  });

  it.each(["server", "network"] as const)("settles a fast %s failure without uncertain feedback and allows retry", async (failure) => {
    const f = fixture(true);
    f.enter({ bio: "Keep this draft" });
    f.form.dispatch("submit");
    if (failure === "network") f.requests[0]!.reject(new Error("offline"));
    else f.requests[0]!.resolve({ ok: false, status: 503 });
    await flush();
    expect(f.notice("profile-save-failed")).not.toBeNull();
    expect(f.uncertain()).toBeNull();
    expect(f.timers).toHaveLength(0);
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
    f.form.dispatch("submit");
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.bio.textContent).toBe("Keep this draft");
  });

  it("cancel disposes the deadline timer and aborts the pending save", async () => {
    const f = fixture(true);
    f.enter({ bio: "Cancelled write" });
    f.form.dispatch("submit");
    f.cancel();
    expect(f.requests[0]!.init.signal?.aborted).toBe(true);
    expect(f.timers).toHaveLength(0);
    f.requests[0]!.reject(Object.assign(new Error("offline"), { name: "AbortError" }));
    await flush();
    for (const id of [PROFILE_UNCERTAIN_TESTID, "profile-saved", "profile-save-failed"]) expect(f.notice(id)).toBeNull();
    // Immediately usable: the next save sends exactly one PATCH.
    f.enter({ bio: "New write" });
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("New write");
  });

  it("cancel after the deadline clears uncertain feedback and stays usable", async () => {
    const f = fixture(true);
    f.enter({ bio: "Hung write" });
    f.form.dispatch("submit");
    f.advance(PROFILE_SAVE_DEADLINE_MS);
    await flush();
    expect(f.uncertain()).not.toBeNull();
    f.cancel();
    expect(f.uncertain()).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.document.activeElement).toBe(f.name);
    f.enter({ bio: "After uncertain" });
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.bio.textContent).toBe("After uncertain");
  });
});
