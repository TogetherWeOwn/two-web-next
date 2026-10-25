// Acceptance contract: a delayed profile-save refusal must respect work the
// member deliberately did while the save was in flight, exactly as a delayed
// success already does. After deliberate interaction in (or away from) the
// editor, a 422 (including a late-arriving or unreadable response body), a
// server failure, a transport failure, or an unproven 2xx body must still
// announce and associate its errors, but must not steal the active control,
// its caret, or the newer draft. An uninterrupted refusal still focuses the
// useful summary, client-side validation still focuses its summary, and a
// refusal that settles after Cancel stays inert.
//
// Everything runs over the shipped public/islands/member-profile.js binder
// with deferred fetch/header/body fixtures. No browser, clock, database or
// live service is used; the real-Chromium caret proof lives with the gated
// browser cases in test/member-profile-native-422-baseline.test.ts.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync("public/islands/member-profile.js", "utf8");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type ResponseFixture = {
  ok: boolean;
  status: number;
  type?: string;
  json?: () => Promise<unknown>;
};

// Only the DOM surface used by the shipped binder. Focus is modelled as
// document.activeElement; the caret is the control's selection range, which a
// focus steal would take away from the member's control in a real browser.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  hidden = false;
  href = "";
  value = "";
  defaultValue = "";
  selectionStart: number | null = null;
  selectionEnd: number | null = null;
  scrolls: unknown[] = [];
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
  scrollIntoView(options: unknown) {
    this.scrolls.push(options);
  }
  remove() {
    if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
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
  const node = (parent: Element, tag: string, testid?: string, text?: string) => {
    const el = document.createElement(tag);
    if (testid) el.setAttribute("data-testid", testid);
    if (text) el.textContent = text;
    return parent.appendChild(el);
  };
  const name = node(page, "h1", "profile-name", "Fixture member");
  node(page, "p", "profile-bio", "Original bio");
  node(page, "div", "profile-games");
  node(page, "p", "profile-timezone", "Timezone: UTC");
  node(page, "section", "profile-new-member").hidden = true;
  const root = node(page, "section", "profile-edit");
  root.setAttribute("data-island", "member-profile");
  root.setAttribute("data-member-id", "100000000000000001");
  const editControl = node(root, "div", "profile-edit-control");
  editControl.hidden = true;
  node(editControl, "button", "profile-edit-again", "Edit your profile");
  const form = Object.assign(node(root, "form", "profile-form"), {
    elements: {} as Record<string, Element>,
  });
  for (const [key, tag, value] of [
    ["bio", "textarea", "Original bio"],
    ["games_text", "textarea", "Chess"],
    ["timezone", "input", "UTC"],
    ["website", "input", ""],
    ["formOpenedAt", "input", "1800000000000"],
  ] as const) {
    const field = document.createElement(tag);
    field.value = field.defaultValue = value;
    const labelled = key === "bio" || key === "games_text" || key === "timezone";
    (labelled ? form.appendChild(document.createElement("label")) : form).appendChild(field);
    form.elements[key] = field;
  }
  const requests: ReturnType<typeof deferred<ResponseFixture>>[] = [];
  const fetch = vi.fn(() => {
    const request = deferred<ResponseFixture>();
    requests.push(request);
    return request.promise;
  });
  const timers: (() => void)[] = [];
  runInNewContext(binder, {
    document,
    window: new EventTarget(),
    fetch,
    location: { pathname: "/members/100000000000000001", search: "" },
    setTimeout: (callback: () => void) => timers.push(callback),
    Intl,
  });
  const notice = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  const byId = (id: string) => root.querySelector(`[id="${id}"]`);
  // Start a save as the member would: focus in the editor, a valid draft,
  // then submit. The fetch stays unsettled until the test completes it.
  const submit = () => {
    form.elements.bio!.value = "Submitted bio";
    form.elements.bio!.focus();
    form.dispatch("submit");
    expect(fetch).toHaveBeenCalledTimes(requests.length);
    expect(requests.length).toBeGreaterThan(0);
  };
  // Deliberate newer work during the pending save: move to another control,
  // type a newer draft, and leave the caret mid-word.
  const deliberate = (key = "games_text", draft = "Newer draft typed after save") => {
    const control = form.elements[key]!;
    control.focus();
    form.dispatch("focusin");
    control.value = draft;
    control.selectionStart = 6;
    control.selectionEnd = 11;
    form.dispatch("input");
    return control;
  };
  const cancel = () => {
    form.dispatch("reset");
    Object.values(form.elements).forEach((field) => {
      field.value = field.defaultValue;
    });
    timers.splice(0).forEach((callback) => callback());
  };
  return { document, root, name, form, fetch, requests, notice, byId, submit, deliberate, cancel };
}

const BIO_ERROR = "Keep your bio to 1000 characters or fewer.";
const refusals = {
  "422 validation": {
    alert: "profile-error",
    settle: (f: ReturnType<typeof fixture>) =>
      f.requests[0]!.resolve({
        ok: false,
        status: 422,
        json: async () => ({ errors: { bio: BIO_ERROR } }),
      }),
  },
  "422 with an unreadable body": {
    alert: "profile-error",
    settle: (f: ReturnType<typeof fixture>) =>
      f.requests[0]!.resolve({
        ok: false,
        status: 422,
        json: () => Promise.reject(new Error("truncated body")),
      }),
  },
  "500 server failure": {
    alert: "profile-save-failed",
    settle: (f: ReturnType<typeof fixture>) => f.requests[0]!.resolve({ ok: false, status: 500 }),
  },
  "transport failure": {
    alert: "profile-save-failed",
    settle: (f: ReturnType<typeof fixture>) => f.requests[0]!.reject(new Error("offline")),
  },
  "2xx body that is not a saved acknowledgement": {
    alert: "profile-save-failed",
    settle: (f: ReturnType<typeof fixture>) =>
      f.requests[0]!.resolve({ ok: true, status: 200, json: async () => ({ saved: false }) }),
  },
  "2xx with an unreadable body": {
    alert: "profile-save-failed",
    settle: (f: ReturnType<typeof fixture>) =>
      f.requests[0]!.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error("truncated body")),
      }),
  },
} as const;
type Refusal = keyof typeof refusals;
const refusalNames = Object.keys(refusals) as Refusal[];

describe("delayed profile refusals preserve deliberate newer focus", () => {
  it.each(refusalNames)(
    "%s after deliberate editing keeps the active control, caret and newer draft",
    async (kind) => {
      const f = fixture();
      f.submit();
      const control = f.deliberate();
      refusals[kind].settle(f);
      await flush();

      const alert = f.notice(refusals[kind].alert);
      // The refusal is still announced, the editor stays open for retry and
      // the pending state is released.
      expect(alert?.getAttribute("role")).toBe("alert");
      expect(f.form.hidden).toBe(false);
      expect(f.form.getAttribute("aria-busy")).toBeNull();
      // But it does not steal what the member deliberately moved to.
      expect(f.document.activeElement).toBe(control);
      expect(control.value).toBe("Newer draft typed after save");
      expect(control.selectionStart).toBe(6);
      expect(control.selectionEnd).toBe(11);
      // The submitted draft in the other field is kept too, and nothing was
      // accepted: the baseline is still the original profile.
      expect(f.form.elements.bio!.value).toBe(
        control === f.form.elements.bio ? control.value : "Submitted bio",
      );
      expect(f.form.elements.bio!.defaultValue).toBe("Original bio");
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );

  it("422 body arriving after the headers still respects editing done in between", async () => {
    const f = fixture();
    const body = deferred<unknown>();
    f.submit();
    // Headers land first; the member keeps working while the body streams.
    f.requests[0]!.resolve({ ok: false, status: 422, json: () => body.promise });
    await flush();
    const control = f.deliberate("timezone", "Europe/Paris");
    body.resolve({ errors: { bio: BIO_ERROR } });
    await flush();

    expect(f.notice("profile-error")?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(control);
    expect(control.value).toBe("Europe/Paris");
    expect(control.selectionStart).toBe(6);
    expect(control.selectionEnd).toBe(11);
  });

  it("unproven 2xx body arriving after the headers still respects editing done in between", async () => {
    const f = fixture();
    const body = deferred<unknown>();
    f.submit();
    f.requests[0]!.resolve({ ok: true, status: 200, json: () => body.promise });
    await flush();
    const control = f.deliberate();
    body.resolve({ saved: false });
    await flush();

    expect(f.notice("profile-save-failed")?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(control);
    expect(control.value).toBe("Newer draft typed after save");
    expect(control.selectionStart).toBe(6);
    expect(control.selectionEnd).toBe(11);
  });

  it("typing on in the same field during the save keeps its caret when the refusal lands", async () => {
    const f = fixture();
    f.submit();
    const bio = f.form.elements.bio!;
    // Focus never leaves the field the save started from; only the caret and
    // text move, which deliberate editing looks like for the success path.
    bio.value = "Submitted bio, still typing";
    bio.selectionStart = 15;
    bio.selectionEnd = 15;
    f.form.dispatch("input");
    f.requests[0]!.resolve({ ok: false, status: 500 });
    await flush();

    expect(f.notice("profile-save-failed")?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(bio);
    expect(bio.value).toBe("Submitted bio, still typing");
    expect(bio.selectionStart).toBe(15);
    expect(bio.selectionEnd).toBe(15);
  });

  it("moving focus away from the editor during the save is respected like the success path", async () => {
    const f = fixture();
    f.submit();
    f.name.focus();
    f.requests[0]!.reject(new Error("offline"));
    await flush();

    expect(f.notice("profile-save-failed")?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(f.name);
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
  });

  it("keyed 422 after deliberate editing keeps field association and the summary link still focuses on demand", async () => {
    const f = fixture();
    f.submit();
    const control = f.deliberate();
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: BIO_ERROR, games: "Add no more than 20 games." } }),
    });
    await flush();

    expect(f.document.activeElement).toBe(control);
    const bio = f.form.elements.bio!;
    expect(bio.getAttribute("aria-invalid")).toBe("true");
    expect(bio.getAttribute("aria-describedby")).toContain("profile-bio-error");
    expect(f.byId("profile-bio-error")?.textContent).toBe(BIO_ERROR);
    const games = f.form.elements.games_text!;
    expect(games.getAttribute("aria-invalid")).toBe("true");
    expect(games.getAttribute("aria-describedby")).toContain("profile-games-text-error");
    expect(f.byId("profile-games-text-error")?.textContent).toBe("Add no more than 20 games.");
    const summary = f.notice("profile-error")!;
    expect(summary.getAttribute("role")).toBe("alert");
    const links = summary.querySelectorAll("a");
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#profile-bio",
      "#profile-games-text",
    ]);
    // Choosing the summary link is itself deliberate: it still moves focus.
    links[0]!.focus();
    links[0]!.dispatch("click");
    expect(f.document.activeElement).toBe(bio);
    expect(control.value).toBe("Newer draft typed after save");
  });

  it("unified 422 fields envelope keeps field association (errors stays the legacy fallback)", async () => {
    // The server now answers { error: "invalid", fields }; the island reads
    // `fields` first and `errors` only so a cached island survives the
    // rollout. This pins the new shape; the keyed-422 case above pins the
    // legacy key. Reverting the island to `j.errors` must fail here.
    const f = fixture();
    f.submit();
    const control = f.deliberate();
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ error: "invalid", fields: { bio: BIO_ERROR } }),
    });
    await flush();

    expect(f.document.activeElement).toBe(control);
    const bio = f.form.elements.bio!;
    expect(bio.getAttribute("aria-invalid")).toBe("true");
    expect(bio.getAttribute("aria-describedby")).toContain("profile-bio-error");
    expect(f.byId("profile-bio-error")?.textContent).toBe(BIO_ERROR);
    const summary = f.notice("profile-error")!;
    expect(summary.getAttribute("role")).toBe("alert");
    expect(summary.querySelectorAll("a").map((a) => a.getAttribute("href"))).toEqual([
      "#profile-bio",
    ]);
  });

  it("after a refusal that respected newer work, a deliberate retry can still save", async () => {
    const f = fixture();
    f.submit();
    const control = f.deliberate("bio", "Corrected while the first save was pending");
    f.requests[0]!.resolve({ ok: false, status: 500 });
    await flush();
    expect(f.document.activeElement).toBe(control);

    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve({
      ok: true,
      status: 200,
      json: async () => ({ saved: true, message: "Profile saved." }),
    });
    await flush();
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.notice("profile-saved")?.getAttribute("role")).toBe("status");
  });
});

describe("uninterrupted profile refusals still focus the useful summary", () => {
  it.each(refusalNames)("%s with no intervening work focuses its alert", async (kind) => {
    const f = fixture();
    f.submit();
    refusals[kind].settle(f);
    await flush();

    const alert = f.notice(refusals[kind].alert);
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(alert);
    expect(f.form.hidden).toBe(false);
    expect(f.form.getAttribute("aria-busy")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Submitted bio");
  });

  it("synchronous client validation still focuses its summary and sends nothing", () => {
    const f = fixture();
    f.form.elements.bio!.value = `a${String.fromCharCode(1)}b`;
    f.form.elements.bio!.focus();
    f.form.dispatch("submit");

    const summary = f.notice("profile-error");
    expect(summary?.getAttribute("role")).toBe("alert");
    expect(f.document.activeElement).toBe(summary);
    expect(f.fetch).not.toHaveBeenCalled();
  });
});

describe("stale cancelled profile refusals stay inert", () => {
  it.each(["422 validation", "500 server failure", "transport failure"] as const)(
    "%s settling after Cancel shows nothing and leaves Cancel's focus alone",
    async (kind) => {
      const f = fixture();
      f.submit();
      f.cancel();
      expect(f.document.activeElement).toBe(f.name);
      refusals[kind].settle(f);
      await flush();

      for (const id of ["profile-error", "profile-save-failed", "profile-saved"])
        expect(f.notice(id)).toBeNull();
      expect(f.byId("profile-bio-error")).toBeNull();
      expect(f.form.elements.bio!.getAttribute("aria-invalid")).toBeNull();
      expect(f.document.activeElement).toBe(f.name);
      expect(f.form.elements.bio!.value).toBe("Original bio");
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );

  it("422 body completing after Cancel cannot revive focus or field errors", async () => {
    const f = fixture();
    const body = deferred<unknown>();
    f.submit();
    f.requests[0]!.resolve({ ok: false, status: 422, json: () => body.promise });
    await flush();
    f.cancel();
    expect(f.document.activeElement).toBe(f.name);
    body.resolve({ errors: { bio: BIO_ERROR } });
    await flush();

    expect(f.notice("profile-error")).toBeNull();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.document.activeElement).toBe(f.name);
    expect(f.form.elements.bio!.value).toBe("Original bio");
  });
});
