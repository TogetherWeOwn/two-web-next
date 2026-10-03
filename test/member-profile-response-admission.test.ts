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
const ack = () => ({
  ok: true,
  status: 200,
  json: async () => ({ saved: true, message: "Profile saved." }),
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

// Only the DOM surface used by the shipped binder. Network and reset timers
// are explicitly completed by each test; no browser, clock or live DB needed.
class Element {
  children: Element[] = [];
  parentNode: Element | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: { preventDefault: () => void }) => void)[]> = {};
  hidden = false;
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
  setAttribute(key: string, value: string) {
    this.attributes[key] = value;
  }
  getAttribute(key: string) {
    return this.attributes[key] ?? null;
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
    elements: Object.fromEntries(
      Object.entries({
        bio: "Original bio",
        games_text: "Chess",
        timezone: "UTC",
        website: "",
        formOpenedAt: "1800000000000",
        _method: "PATCH",
      }).map(([key, value]) => {
        const field = node(
          root.querySelector("form")!,
          key === "bio" || key === "games_text" ? "textarea" : "input",
        );
        field.value = field.defaultValue = value;
        return [key, field];
      }),
    ) as Record<string, Element>,
  });
  const requests: ReturnType<typeof deferred<ResponseFixture>>[] = [];
  const fetch = vi.fn(() => {
    const request = deferred<ResponseFixture>();
    requests.push(request);
    return request.promise;
  });
  const timers: (() => void)[] = [];
  runInNewContext(binder, {
    document,
    fetch,
    location: { pathname: "/members/100000000000000001" },
    setTimeout: (callback: () => void) => timers.push(callback),
    Intl,
  });
  const enter = (values: Partial<Record<"bio" | "games_text" | "timezone", string>>) => {
    for (const [key, value] of Object.entries(values)) form.elements[key]!.value = value;
  };
  const cancel = () => {
    form.dispatch("reset");
    Object.values(form.elements).forEach((field) => {
      field.value = field.defaultValue;
    });
    timers.splice(0).forEach((callback) => callback());
  };
  const notice = (id: string) => root.querySelector(`[data-testid="${id}"]`);
  return {
    document,
    root,
    name,
    heading,
    bio,
    games,
    timezone,
    form,
    edit,
    editControl,
    fetch,
    requests,
    enter,
    cancel,
    notice,
  };
}

describe("member-profile response admission", () => {
  it("accepts a valid saved:true acknowledgement", async () => {
    const f = fixture();
    f.enter({ bio: "Accepted bio", games_text: "Go\nChess", timezone: "Europe/London" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve(ack());
    await flush();
    await flush();
    expect(f.bio.textContent).toBe("Accepted bio");
    expect(f.notice("profile-saved")?.textContent).toBe("Profile saved.");
    expect(f.notice("profile-save-failed")).toBeNull();
    expect(f.form.hidden).toBe(true);
    expect(f.editControl.hidden).toBe(false);
    expect(f.document.activeElement).toBe(f.notice("profile-saved"));
  });

  it.each([
    [
      "200 HTML",
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token");
        },
      },
    ],
    ["unrelated JSON", { ok: true, status: 200, json: async () => ({ ok: true }) }],
    ["saved:false", { ok: true, status: 200, json: async () => ({ saved: false }) }],
    [
      "malformed JSON",
      {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("bad json");
        },
      },
    ],
    ["missing json", { ok: true, status: 200 }],
    ["null body", { ok: true, status: 200, json: async () => null }],
    ["string body", { ok: true, status: 200, json: async () => "saved" }],
  ])("preserves the draft and never announces success for %s", async (_label, response) => {
    const f = fixture();
    f.enter({ bio: "Keep this draft", games_text: "Go" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve(response as ResponseFixture);
    await flush();
    await flush();
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
    expect(f.form.hidden).toBe(false);
    const failed = f.notice("profile-save-failed");
    expect(failed?.getAttribute("role")).toBe("alert");
    expect(failed?.textContent).toContain("Could not save");
    expect(f.document.activeElement).toBe(failed);
    // Retry stays usable after the settled failure.
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.requests[1]!.resolve(ack());
    await flush();
    await flush();
    expect(f.bio.textContent).toBe("Keep this draft");
    expect(f.notice("profile-saved")).not.toBeNull();
  });

  it.each([
    ["empty object", {}],
    ["missing errors", { saved: false }],
    ["null errors", { errors: null }],
    ["empty errors", { errors: {} }],
    ["array errors", { errors: [] }],
    ["non-string values", { errors: { bio: 42, games: { text: "x" } } }],
    ["null body", null],
    ["string body", "invalid"],
    ["number body", 42],
  ])("maps malformed or empty 422 %s to a nonempty generic alert", async (_label, body) => {
    const f = fixture();
    f.enter({ bio: "Keep this draft" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve({ ok: false, status: 422, json: async () => body });
    await flush();
    await flush();
    const alert = f.notice("profile-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(alert?.textContent?.trim().length).toBeGreaterThan(0);
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
    expect(f.form.hidden).toBe(false);
    expect(f.document.activeElement).toBe(alert);
  });

  it("maps a rejected 422 JSON body to a nonempty generic alert", async () => {
    const f = fixture();
    f.enter({ bio: "Keep this draft" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    });
    await flush();
    await flush();
    const alert = f.notice("profile-error");
    expect(alert?.textContent?.trim().length).toBeGreaterThan(0);
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
  });

  it("renders bounded string errors as literal text", async () => {
    const f = fixture();
    const long = "x".repeat(5000);
    const html = "<img src=x onerror=alert(1)>";
    f.enter({ bio: "Keep this draft" });
    f.form.dispatch("submit");
    f.requests[0]!.resolve({
      ok: false,
      status: 422,
      json: async () => ({ errors: { bio: long, games: html } }),
    });
    await flush();
    await flush();
    const alert = f.notice("profile-error");
    expect(alert).not.toBeNull();
    const items = alert!.querySelectorAll("li").map((li) => li.textContent);
    expect(items).toHaveLength(2);
    // Bounded: no single rendered error blows up the DOM.
    for (const text of items) expect([...text].length).toBeLessThanOrEqual(500);
    expect(items[0]).toBe("x".repeat(500));
    // Literal: markup is text, never an element.
    expect(items[1]).toBe(html);
    expect(alert!.querySelector("img")).toBeNull();
    expect(f.form.elements.bio!.value).toBe("Keep this draft");
  });

  it("ignores a late acknowledgement after cancel", async () => {
    const f = fixture();
    f.enter({ bio: "Cancelled write" });
    f.form.dispatch("submit");
    f.cancel();
    f.requests[0]!.resolve(ack());
    await flush();
    await flush();
    expect(f.notice("profile-saved")).toBeNull();
    expect(f.bio.textContent).toBe("Original bio");
    expect(f.form.elements.bio!.value).toBe("Original bio");
    expect(f.document.activeElement).toBe(f.name);
  });

  it("keeps client validation and the submitted request contract intact", () => {
    const f = fixture();
    f.enter({ bio: "x".repeat(1001) });
    f.form.dispatch("submit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.notice("profile-error")?.textContent).toContain("1000 characters");
  });
});
