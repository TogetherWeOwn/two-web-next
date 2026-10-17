// Acceptance: a leaderboard opt-out choice made while an older profile save
// is still in flight must survive that save's acknowledgement, even after
// focus moves away from the checkbox (here, to Bio) before the response
// arrives. The acknowledgement may only advance the saved/reset baseline
// (defaultChecked); the newer checked value stays as an unsaved draft with
// native beforeunload protection, the editor stays open, and the draft is
// sent only by an explicit later Save — never automatically.
//
// The fixture models the real form shape rendered by the profile page: a
// hidden fallback input and a checkbox sharing name="leaderboard_opt_out"
// (values "0"/"1"), so form.elements.leaderboard_opt_out is the same-name
// control list a browser exposes, not a single element. It runs the shipped
// distributed island (public/islands/member-profile.js) against deferred
// fetch fixtures only — no browser, clock, network or live DB.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const binder = readFileSync("public/islands/member-profile.js", "utf8");

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
const success = () => ({
  ok: true,
  status: 200,
  json: async () => ({ saved: true, message: "Profile saved." }),
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only the DOM surface used by the shipped binder, mirroring the lifecycle
// suite's harness. Checkbox state lives in checked/defaultChecked, exactly
// the properties native form reset and dirty detection consult.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  hidden = false;
  href = "";
  type = "";
  value = "";
  defaultValue = "";
  checked = false;
  defaultChecked = false;
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
  insertBefore(child: Element, before: Element) {
    child.parentNode = this;
    this.children.splice(this.children.indexOf(before), 0, child);
  }
  after(node: Element) {
    const parent = this.parentNode!;
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  scrolls: unknown[] = [];
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

function fixture(initialOptOut: boolean) {
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
  const bio = node(page, "p", "profile-bio", "Original bio");
  const games = node(page, "div", "profile-games");
  node(games, "ul").appendChild(document.createTextNode("Chess"));
  const timezone = node(page, "p", "profile-timezone", "Timezone: UTC");
  const newMember = node(page, "section", "profile-new-member");
  newMember.hidden = true;
  const cta = node(newMember, "a", "profile-new-member-cta", "Add profile details");
  const root = node(page, "section", "profile-edit");
  root.setAttribute("data-island", "member-profile");
  root.setAttribute("data-member-id", "100000000000000001");
  const heading = node(root, "h2");
  heading.setAttribute("id", "edit-heading");
  const editControl = node(root, "div", "profile-edit-control");
  editControl.hidden = true;
  const edit = node(editControl, "button", "profile-edit-again", "Edit your profile");
  const form = node(root, "form", "profile-form");
  const field = (tag: string, controlName: string, value: string, type = "") => {
    const el = node(form, tag);
    el.setAttribute("name", controlName);
    el.type = type;
    el.value = el.defaultValue = value;
    return el;
  };
  // The real same-name pair, in rendered order: hidden fallback first so an
  // unchecked box still submits "0", then the checkbox itself.
  const optOutHidden = field("input", "leaderboard_opt_out", "0", "hidden");
  const optOut = field("input", "leaderboard_opt_out", "1", "checkbox");
  optOut.setAttribute("id", "profile-leaderboard-opt-out");
  optOut.checked = optOut.defaultChecked = initialOptOut;
  const textFields = Object.fromEntries(
    Object.entries({
      bio: "Original bio",
      games_text: "Chess",
      timezone: "UTC",
      website: "",
      formOpenedAt: "1800000000000",
      _method: "PATCH",
    }).map(([key, value]) => [
      key,
      field(key === "bio" || key === "games_text" ? "textarea" : "input", key, value),
    ]),
  );
  const formWithElements = Object.assign(form, {
    elements: {
      ...textFields,
      // A browser exposes same-name controls as one list entry; the island
      // must find the checkbox inside it, never the hidden fallback.
      leaderboard_opt_out: [optOutHidden, optOut],
    } as Record<string, Element | Element[]>,
  });
  const requests: ReturnType<typeof deferred<ResponseFixture>>[] = [];
  const fetch = vi.fn((_url: string, _init?: unknown) => {
    const request = deferred<ResponseFixture>();
    requests.push(request);
    return request.promise;
  });
  const timers: (() => void)[] = [];
  const window = new EventTarget();
  runInNewContext(binder, {
    document,
    window,
    fetch,
    location: { pathname: "/members/100000000000000001", search: "" },
    setTimeout: (callback: () => void) => timers.push(callback),
    Intl,
  });
  const submittedOptOut = (index: number) =>
    JSON.parse((fetch.mock.calls[index]![1] as { body: string }).body).leaderboard_opt_out;
  // Focus the switch and flip it, then bubble the change the way a real
  // checkbox activation does (input/change reach form listeners).
  const toggleOptOut = (next: boolean) => {
    optOut.focus();
    optOut.checked = next;
    optOut.dispatch("change");
    form.dispatch("input");
    form.dispatch("change");
  };
  const focusBio = () => {
    (textFields.bio as Element).focus();
    form.dispatch("focusin");
  };
  const cancel = () => {
    form.dispatch("reset");
    // Native form reset restores every control to its default.
    for (const el of Object.values(textFields)) el.value = el.defaultValue;
    optOut.checked = optOut.defaultChecked;
    optOutHidden.value = optOutHidden.defaultValue;
    timers.splice(0).forEach((callback) => callback());
  };
  const departure = () => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  };
  return {
    document,
    root,
    name,
    heading,
    bio,
    games,
    timezone,
    newMember,
    cta,
    form: formWithElements,
    textFields,
    optOut,
    optOutHidden,
    edit,
    editControl,
    fetch,
    requests,
    submittedOptOut,
    toggleOptOut,
    focusBio,
    cancel,
    departure,
    notice: (id: string) => root.querySelector(`[data-testid="${id}"]`),
  };
}

// Start an older save (bio edit, checkbox still at its initial value), flip
// the switch while it is pending, move focus to Bio, then deliver the older
// acknowledgement. Returns the fixture in the post-acknowledgement state.
async function pendingToggleThenAck(initial: boolean) {
  const f = fixture(initial);
  const newer = !initial;
  f.textFields.bio!.value = "Saved bio";
  f.form.dispatch("submit");
  expect(f.fetch).toHaveBeenCalledOnce();
  expect(f.submittedOptOut(0)).toBe(initial);
  f.toggleOptOut(newer);
  f.focusBio();
  f.requests[0]!.resolve(success());
  await flush();
  return { f, newer };
}

describe("member-profile leaderboard opt-out draft during a pending save", () => {
  it("exposes the real hidden-fallback plus checkbox shape and submits the initial choice", () => {
    const f = fixture(true);
    const list = f.form.elements.leaderboard_opt_out as Element[];
    expect(list).toHaveLength(2);
    expect(list[0]).toBe(f.optOutHidden);
    expect(f.optOutHidden.type).toBe("hidden");
    expect(f.optOutHidden.value).toBe("0");
    expect(list[1]).toBe(f.optOut);
    expect(f.optOut.type).toBe("checkbox");
    expect(f.optOut.value).toBe("1");
    expect(f.optOut.checked).toBe(true);
    expect(f.optOut.defaultChecked).toBe(true);
    f.form.dispatch("submit");
    expect(f.submittedOptOut(0)).toBe(true);
  });

  it.each([
    { label: "false-to-true", initial: false },
    { label: "true-to-false", initial: true },
  ])(
    "preserves a newer $label choice after focus moves to Bio and the older save lands",
    async ({ initial }) => {
      const { f, newer } = await pendingToggleThenAck(initial);
      // The acknowledgement advances only the saved/reset baseline.
      expect(f.optOut.defaultChecked).toBe(initial);
      // The newer choice itself is not written back by the older response.
      expect(f.optOut.checked).toBe(newer);
      // Focus stays where the member put it, and the editor stays open.
      expect(f.document.activeElement).toBe(f.textFields.bio);
      expect(f.form.hidden).toBe(false);
      expect(f.editControl.hidden).toBe(true);
      // The unsaved choice keeps native departure protection.
      expect(f.departure().defaultPrevented).toBe(true);
      // The draft is never resent on its own.
      expect(f.fetch).toHaveBeenCalledOnce();
      // The hidden fallback is untouched throughout.
      expect(f.optOutHidden.value).toBe("0");
      expect(f.bio.textContent).toBe("Saved bio");
    },
  );

  it.each([
    { label: "false-to-true", initial: false },
    { label: "true-to-false", initial: true },
  ])("cancel restores the last acknowledged $label baseline", async ({ initial }) => {
    const { f, newer } = await pendingToggleThenAck(initial);
    expect(f.optOut.checked).toBe(newer);
    f.cancel();
    expect(f.optOut.checked).toBe(initial);
    expect(f.optOut.defaultChecked).toBe(initial);
    expect(f.departure().defaultPrevented).toBe(false);
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { label: "false-to-true", initial: false },
    { label: "true-to-false", initial: true },
  ])("an explicit later Save submits the newer $label choice", async ({ initial }) => {
    const { f, newer } = await pendingToggleThenAck(initial);
    expect(f.optOut.checked).toBe(newer);
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.submittedOptOut(1)).toBe(newer);
    f.requests[1]!.resolve(success());
    await flush();
    expect(f.optOut.checked).toBe(newer);
    expect(f.optOut.defaultChecked).toBe(newer);
    expect(f.departure().defaultPrevented).toBe(false);
  });

  it("settles cleanly when the checkbox is untouched during the save", async () => {
    const f = fixture(true);
    f.textFields.bio!.value = "Saved bio ";
    f.textFields.games_text!.value = "Go\nChess\n";
    f.form.dispatch("submit");
    f.textFields.timezone!.focus();
    f.form.dispatch("focusin");
    f.requests[0]!.resolve(success());
    await flush();
    expect(f.optOut.checked).toBe(true);
    expect(f.optOut.defaultChecked).toBe(true);
    // Existing text normalization and focus behavior remain intact.
    expect(f.textFields.bio!.value).toBe("Saved bio");
    expect(f.textFields.games_text!.value).toBe("Go\nChess");
    expect(f.document.activeElement).toBe(f.textFields.timezone);
    expect(f.departure().defaultPrevented).toBe(false);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
