// Composition-limits acceptance: live counts in the shipped island binder.
//
// The member-profile binder refreshes the SSR hint/count nodes (see
// test/profile-composition-hints.test.ts for the markup contract) after
// input, explicit reset and accepted-save normalization. Rules pinned here:
//
// - Bio counts Unicode code points ([...value].length); emoji is 1, a
//   combining mark is its own code point (2 for "e" + U+0301).
// - Games mirror the server exactly: CRLF/CR/LF split, trim, blank omission,
//   case-sensitive dedupe; raw budget counts raw code points; overlong
//   trimmed lines are identified by 1-based line number.
// - Typing makes zero requests, truncates nothing, adds no maxlength, sets
//   no aria-invalid and announces nothing (no live regions change).
// - Reset and accepted-save refresh counts from the restored/normalized
//   values. Error cleanup (accept or reset) removes error tokens while the
//   persistent hint+count tokens stay. Pending/rejected/late ownership,
//   drafts and Save/Cancel semantics are unchanged.
//
// The fixture below mirrors post-Builder SSR (hints/counts present, count
// nodes reused, never duplicated). Pre-Builder the shipped binder ignores
// input for counting, so the live-count assertions fail for the intended
// missing behavior; the server-parity controls pass today and prove the
// battery matches the real validator. Builder must not edit this file;
// defects return as a bounded follow-up. Local fixtures only.
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { validateProfile } from "../src/profiles/validation";

const BIO_HINT_ID = "profile-bio-hint";
const BIO_COUNT_ID = "profile-bio-count";
const GAMES_HINT_ID = "profile-games-text-hint";
const GAMES_COUNT_ID = "profile-games-text-count";
const BIO_HINT_COPY = "Up to 1000 characters.";
const GAMES_HINT_COPY =
  "Up to 20 games, one per line: 80 characters per game, 1700 characters total.";

type BatteryCase = { name: string; field: "bio" | "games_text"; value: string; expected: string };

const games20 = Array.from({ length: 20 }, (_, i) => `game${i}`).join("\n");
const games21 = Array.from({ length: 21 }, (_, i) => `game${i}`).join("\n");
const raw1700 = [
  ...Array<string>(19).fill("g".repeat(80)),
  `${"g".repeat(80)}${" ".repeat(81)}`,
].join("\n");
const combo21 = Array.from({ length: 21 }, (_, i) => `n${i}-${"y".repeat(78)}`).join("\n");
const comboLines = `lines ${Array.from({ length: 21 }, (_, i) => `${i + 1}`).join(", ")} over 80 characters`;

const BIO_CASES: BatteryCase[] = [
  { name: "empty bio shows zero", field: "bio", value: "", expected: "0 of 1000 characters" },
  {
    name: "short bio counts code points",
    field: "bio",
    value: "hi",
    expected: "2 of 1000 characters",
  },
  {
    name: "emoji counts as one code point, not two UTF-16 units",
    field: "bio",
    value: "🎮",
    expected: "1 of 1000 characters",
  },
  {
    name: "ten emoji count ten, not twenty",
    field: "bio",
    value: "🎮".repeat(10),
    expected: "10 of 1000 characters",
  },
  {
    name: "combining mark counts as its own code point",
    field: "bio",
    value: "e\u0301",
    expected: "2 of 1000 characters",
  },
  {
    name: "bio at exactly 1000 is at the limit",
    field: "bio",
    value: "a".repeat(1000),
    expected: "1000 of 1000 characters",
  },
  {
    name: "bio at 1001 names the overage in words",
    field: "bio",
    value: "a".repeat(1001),
    expected: "1001 of 1000 characters (1 over the limit)",
  },
  {
    name: "1001 emoji are over by one code point, not 1002 UTF-16 units",
    field: "bio",
    value: "🎮".repeat(1001),
    expected: "1001 of 1000 characters (1 over the limit)",
  },
  {
    name: "999 code points in 1000 UTF-16 units stay in budget",
    field: "bio",
    value: `${"x".repeat(998)}🎮`,
    expected: "999 of 1000 characters",
  },
];

const GAMES_CASES: BatteryCase[] = [
  {
    name: "empty games show zero of both budgets",
    field: "games_text",
    value: "",
    expected: "0 of 20 games, 0 of 1700 characters",
  },
  {
    name: "single game counts one name and raw length",
    field: "games_text",
    value: "Halo",
    expected: "1 of 20 games, 4 of 1700 characters",
  },
  {
    name: "LF splits names and counts the break once",
    field: "games_text",
    value: "Go\nChess",
    expected: "2 of 20 games, 8 of 1700 characters",
  },
  {
    name: "CRLF splits and counts two code points per break",
    field: "games_text",
    value: "Go\r\nChess",
    expected: "2 of 20 games, 9 of 1700 characters",
  },
  {
    name: "lone CR splits like the server",
    field: "games_text",
    value: "Go\rChess",
    expected: "2 of 20 games, 8 of 1700 characters",
  },
  {
    name: "mixed CRLF, CR and LF all split",
    field: "games_text",
    value: "a\r\nb\rc\nd",
    expected: "4 of 20 games, 8 of 1700 characters",
  },
  {
    name: "dupes collapse after trim, case-distinct names stay, blanks drop",
    field: "games_text",
    value: "Go\nGo\n Go \n\ngo",
    expected: "2 of 20 games, 14 of 1700 characters",
  },
  {
    name: "whitespace-only lines are blanks but still use raw budget",
    field: "games_text",
    value: " \n\t\n",
    expected: "0 of 20 games, 4 of 1700 characters",
  },
  {
    name: "80-character trimmed name is at the per-name limit",
    field: "games_text",
    value: "g".repeat(80),
    expected: "1 of 20 games, 80 of 1700 characters",
  },
  {
    name: "81-character name identifies its line number",
    field: "games_text",
    value: "g".repeat(81),
    expected: "1 of 20 games, 81 of 1700 characters, line 1 over 80 characters",
  },
  {
    name: "several overlong lines are all identified",
    field: "games_text",
    value: `ok\n${"g".repeat(81)}\n${"h".repeat(85)}`,
    expected: "3 of 20 games, 170 of 1700 characters, lines 2, 3 over 80 characters",
  },
  {
    name: "20 distinct names are at the count limit",
    field: "games_text",
    value: games20,
    expected: "20 of 20 games, 129 of 1700 characters",
  },
  {
    name: "21 distinct names name the count overage in words",
    field: "games_text",
    value: games21,
    expected: "21 of 20 games (1 over the limit), 136 of 1700 characters",
  },
  {
    name: "1700 raw code points are at the raw budget",
    field: "games_text",
    value: raw1700,
    expected: "1 of 20 games, 1700 of 1700 characters",
  },
  {
    name: "1701 raw code points name the raw overage in words",
    field: "games_text",
    value: `${raw1700} `,
    expected: "1 of 20 games, 1701 of 1700 characters (1 over the limit)",
  },
  {
    name: "count, raw and per-name overages combine with every overlong line",
    field: "games_text",
    value: combo21,
    expected: `21 of 20 games (1 over the limit), 1732 of 1700 characters (32 over the limit), ${comboLines}`,
  },
  {
    name: "overlong is measured after trim, raw before it",
    field: "games_text",
    value: `  ${"g".repeat(81)}  `,
    expected: "1 of 20 games, 85 of 1700 characters, line 1 over 80 characters",
  },
  {
    name: "padding around an 80-character name is not overlong",
    field: "games_text",
    value: ` ${"g".repeat(80)} `,
    expected: "1 of 20 games, 82 of 1700 characters",
  },
];

// --- Test-local statement of the pinned counting rules and text format ---

const parseGames = (value: string) => {
  const names: string[] = [];
  const overlong: number[] = [];
  value.split(/\r\n|\r|\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if ([...trimmed].length > 80) overlong.push(index + 1);
    if (trimmed !== "" && !names.includes(trimmed)) names.push(trimmed);
  });
  return { names, raw: [...value].length, overlong };
};

const bioText = (count: number) =>
  count <= 1000
    ? `${count} of 1000 characters`
    : `${count} of 1000 characters (${count - 1000} over the limit)`;

const gamesText = (facts: { names: string[]; raw: number; overlong: number[] }) => {
  const distinct = facts.names.length;
  const games =
    distinct <= 20
      ? `${distinct} of 20 games`
      : `${distinct} of 20 games (${distinct - 20} over the limit)`;
  const raw =
    facts.raw <= 1700
      ? `${facts.raw} of 1700 characters`
      : `${facts.raw} of 1700 characters (${facts.raw - 1700} over the limit)`;
  const lines =
    facts.overlong.length === 0
      ? ""
      : facts.overlong.length === 1
        ? `, line ${facts.overlong[0]} over 80 characters`
        : `, lines ${facts.overlong.join(", ")} over 80 characters`;
  return `${games}, ${raw}${lines}`;
};

describe("battery self-check and server parity (controls: green before the Builder lands)", () => {
  it("every battery literal matches the pinned format for its hand-derived facts", () => {
    for (const entry of BIO_CASES) expect(bioText([...entry.value].length)).toBe(entry.expected);
    for (const entry of GAMES_CASES)
      expect(gamesText(parseGames(entry.value))).toBe(entry.expected);
  });

  it("battery bio counts agree with the server validator", () => {
    for (const entry of BIO_CASES) {
      const result = validateProfile({ bio: entry.value, games: [], timezone: "UTC" });
      if ([...entry.value].length > 1000) {
        expect(result).toEqual({
          ok: false,
          errors: { bio: "Keep your bio to 1000 characters or fewer." },
        });
      } else {
        expect(result.ok).toBe(true);
      }
    }
  });

  it("battery games parses agree with the server validator, including error precedence", () => {
    for (const entry of GAMES_CASES) {
      const facts = parseGames(entry.value);
      const expectedError =
        facts.raw > 1700
          ? "Games list is too long."
          : facts.overlong.length > 0
            ? "Keep each game name to 80 characters or fewer."
            : facts.names.length > 20
              ? "Add no more than 20 games."
              : null;
      const result = validateProfile({ bio: "x", games_text: entry.value, timezone: "UTC" });
      if (expectedError === null) {
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.attrs.games).toEqual(facts.names);
      } else {
        expect(result).toEqual({ ok: false, errors: { games: expectedError } });
      }
    }
  });
});

// --- Minimal DOM for the shipped binder (same surface as the lifecycle suites) ---

const binder = readFileSync("public/islands/member-profile.js", "utf8");
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

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
    const at = this.children.indexOf(before);
    if (at < 0) this.children.push(child);
    else this.children.splice(at, 0, child);
  }
  after(node: Element) {
    const parent = this.parentNode!;
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  scrollIntoView() {}
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
    const attr = selector.match(/^\[([^=\^\]]+)(\^?=)["']([^"']*)["']\]$/);
    const bare = selector.match(/^\[([^\]=\^]+)\]$/);
    return this.children.flatMap((child) => {
      const matches = attr
        ? attr[2] === "^="
          ? child.getAttribute(attr[1]!)?.startsWith(attr[3]!)
          : child.getAttribute(attr[1]!) === attr[3]
        : bare
          ? child.getAttribute(bare[1]!) !== null
          : child.tag === selector;
      return [...(matches ? [child] : []), ...child.querySelectorAll(selector)];
    });
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const SAVED = { bio: "Original bio", games_text: "Chess", timezone: "UTC" };
const SAVED_BIO_COUNT = "12 of 1000 characters";
const SAVED_GAMES_COUNT = "1 of 20 games, 5 of 1700 characters";

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
  node(page, "p", "profile-bio").textContent = SAVED.bio;
  node(page, "p", "profile-timezone").textContent = `Timezone: ${SAVED.timezone}`;
  node(page, "div", "profile-games").textContent = SAVED.games_text;
  const newMember = node(page, "section", "profile-new-member");
  newMember.hidden = true;

  const root = node(page, "section", "profile-edit");
  root.setAttribute("data-island", "member-profile");
  root.setAttribute("data-member-id", "100000000000000001");
  root.setAttribute("data-saved-bio", SAVED.bio);
  root.setAttribute("data-saved-games-text", SAVED.games_text);
  root.setAttribute("data-saved-timezone", SAVED.timezone);
  root.setAttribute("data-saved-leaderboard-opt-out", "0");
  const heading = node(root, "h2");
  heading.setAttribute("id", "edit-heading");
  const editControl = node(root, "div", "profile-edit-control");
  editControl.hidden = true;
  node(editControl, "button", "profile-edit-again").textContent = "Edit your profile";
  const form = Object.assign(node(root, "form", "profile-form"), {
    elements: {} as Record<string, Element>,
  });
  // Post-Builder SSR order per field: hint, count, then the label.
  const field = (
    key: "bio" | "games_text" | "timezone",
    tag: "textarea" | "input",
    hintId: string | null,
    hintCopy: string | null,
    countId: string | null,
    countText: string | null,
  ) => {
    if (hintId && hintCopy && countId && countText) {
      const hint = document.createElement("p");
      hint.setAttribute("id", hintId);
      hint.setAttribute("class", "profile-hint");
      hint.textContent = hintCopy;
      form.appendChild(hint);
      const count = document.createElement("p");
      count.setAttribute("id", countId);
      count.setAttribute("class", "profile-count");
      count.textContent = countText;
      form.appendChild(count);
    }
    const label = document.createElement("label");
    form.appendChild(label);
    const control = document.createElement(tag);
    control.setAttribute(
      "id",
      key === "bio"
        ? "profile-bio"
        : key === "games_text"
          ? "profile-games-text"
          : "profile-timezone",
    );
    control.setAttribute("name", key);
    if (hintId && countId) control.setAttribute("aria-describedby", `${hintId} ${countId}`);
    control.value = control.defaultValue =
      key === "bio" ? SAVED.bio : key === "games_text" ? SAVED.games_text : SAVED.timezone;
    label.appendChild(control);
    form.elements[key] = control;
  };
  field("bio", "textarea", BIO_HINT_ID, BIO_HINT_COPY, BIO_COUNT_ID, SAVED_BIO_COUNT);
  field(
    "games_text",
    "textarea",
    GAMES_HINT_ID,
    GAMES_HINT_COPY,
    GAMES_COUNT_ID,
    SAVED_GAMES_COUNT,
  );
  field("timezone", "input", null, null, null, null);
  for (const key of ["website", "formOpenedAt"]) {
    const extra = document.createElement("input");
    extra.value = extra.defaultValue = key === "formOpenedAt" ? "1800000000000" : "";
    form.appendChild(extra);
    form.elements[key] = extra;
  }

  const requests: {
    resolve: (r: { ok: boolean; status: number; json?: () => Promise<unknown> }) => void;
    reject: (e: Error) => void;
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
    requests.push({ resolve, reject });
    return promise;
  });
  runInNewContext(binder, {
    document,
    window: new EventTarget(),
    fetch,
    location: { pathname: "/members/100000000000000001", search: "" },
    setTimeout,
    queueMicrotask,
    Intl,
  });

  // Real input bubbles from the control to the form; dispatch both so the
  // test holds whatever level the binder listens on.
  const type = (key: "bio" | "games_text" | "timezone", value: string) => {
    form.elements[key]!.value = value;
    form.elements[key]!.dispatch("input");
    form.dispatch("input");
  };
  const cancel = async () => {
    form.dispatch("reset");
    // User-initiated reset drains microtasks before restoring native defaults.
    // Do not use flush(): its setImmediate would also let task timers run.
    await Promise.resolve();
    for (const key of ["bio", "games_text", "timezone"])
      form.elements[key]!.value = form.elements[key]!.defaultValue;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };
  const byId = (id: string) => root.querySelector(`[id="${id}"]`);
  const countById = (id: string) => root.querySelectorAll(`[id="${id}"]`).length;
  const liveRegions = () => [
    ...root.querySelectorAll('[role="alert"]'),
    ...root.querySelectorAll('[role="status"]'),
    ...root.querySelectorAll("[aria-live]"),
  ];
  return { document, root, form, fetch, requests, type, cancel, byId, countById, liveRegions };
}

const savedAck = () => ({ ok: true, status: 200, json: async () => ({ saved: true }) });
const refused = (errors: Record<string, string>) => ({
  ok: false,
  status: 422,
  json: async () => ({ errors }),
});

describe("island live bio counts", () => {
  it.each(BIO_CASES.map((entry) => [entry.name, entry.value, entry.expected]))(
    "%s",
    async (_name, value, expected) => {
      const f = fixture();
      f.type("bio", value as string);
      expect(f.byId(BIO_COUNT_ID)?.textContent).toBe(expected);
      expect(f.form.elements.bio!.value).toBe(value);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("island live games counts", () => {
  it.each(GAMES_CASES.map((entry) => [entry.name, entry.value, entry.expected]))(
    "%s",
    async (_name, value, expected) => {
      const f = fixture();
      f.type("games_text", value as string);
      expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe(expected);
      expect(f.form.elements.games_text!.value).toBe(value);
      expect(f.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("island typing makes no requests, truncates nothing and announces nothing", () => {
  it("a typing session across both fields, in and over budget, fires zero requests", () => {
    const f = fixture();
    f.type("bio", "hi");
    f.type("games_text", "Go\nChess");
    f.type("bio", "🎮".repeat(10));
    f.type("games_text", games21);
    f.type("bio", "a".repeat(1001));
    f.type("games_text", "");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("1001 of 1000 characters (1 over the limit)");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe("0 of 20 games, 0 of 1700 characters");
    expect(f.form.elements.bio!.value).toBe("a".repeat(1001));
  });

  it("over-budget typing leaves validity, errors, live regions and maxlength alone", () => {
    const f = fixture();
    f.type("bio", "a".repeat(1001));
    f.type("games_text", "g".repeat(81));
    for (const id of ["profile-bio-error", "profile-games-text-error", "profile-timezone-error"])
      expect(f.byId(id)).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
    expect(f.form.elements.bio!.getAttribute("aria-invalid")).toBeNull();
    expect(f.form.elements.games_text!.getAttribute("aria-invalid")).toBeNull();
    expect(f.liveRegions()).toHaveLength(0);
    expect(f.byId(BIO_COUNT_ID)?.getAttribute("aria-live")).toBeNull();
    expect(f.byId(BIO_COUNT_ID)?.getAttribute("role")).toBeNull();
    expect(f.byId(GAMES_COUNT_ID)?.getAttribute("aria-live")).toBeNull();
    expect(f.byId(GAMES_COUNT_ID)?.getAttribute("role")).toBeNull();
    expect(f.form.elements.bio!.getAttribute("maxlength")).toBeNull();
    expect(f.form.elements.games_text!.getAttribute("maxlength")).toBeNull();
    expect(f.form.elements.bio!.value).toHaveLength(1001);
    expect(f.form.elements.games_text!.value).toHaveLength(81);
  });

  it("the binder reuses the SSR hint/count nodes instead of duplicating them", () => {
    const f = fixture();
    f.type("bio", "hello");
    f.type("games_text", "a\nb");
    f.type("bio", "a".repeat(1001));
    for (const id of [BIO_HINT_ID, BIO_COUNT_ID, GAMES_HINT_ID, GAMES_COUNT_ID])
      expect(f.countById(id)).toBe(1);
  });
});

describe("island reset refreshes counts from the restored values", () => {
  it("explicit reset restores counts, keeps hints and drops no persistent token", async () => {
    const f = fixture();
    f.type("bio", "a".repeat(1001));
    f.type("games_text", games21);
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("1001 of 1000 characters (1 over the limit)");
    await f.cancel();
    expect(f.form.elements.bio!.value).toBe(SAVED.bio);
    expect(f.form.elements.games_text!.value).toBe(SAVED.games_text);
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe(SAVED_BIO_COUNT);
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe(SAVED_GAMES_COUNT);
    expect(f.byId(BIO_HINT_ID)?.textContent).toBe(BIO_HINT_COPY);
    expect(f.byId(GAMES_HINT_ID)?.textContent).toBe(GAMES_HINT_COPY);
    expect(f.form.elements.bio!.getAttribute("aria-describedby")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID}`,
    );
    expect(f.form.elements.games_text!.getAttribute("aria-describedby")).toBe(
      `${GAMES_HINT_ID} ${GAMES_COUNT_ID}`,
    );
  });

  it("reset never truncates, even when the restored values are over budget", async () => {
    const f = fixture();
    f.form.elements.bio!.defaultValue = "a".repeat(1001);
    f.form.elements.bio!.value = "a".repeat(1001);
    await f.cancel();
    expect(f.form.elements.bio!.value).toBe("a".repeat(1001));
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("1001 of 1000 characters (1 over the limit)");
  });
});

describe("island accepted-save normalization refreshes counts", () => {
  it("counts follow the normalized live values after an uninterrupted save", async () => {
    const f = fixture();
    f.type("bio", "Saved bio ");
    f.type("games_text", "Go\nGo\n\nChess");
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.requests[0]!.resolve(savedAck());
    await flush();
    await flush();
    expect(f.form.elements.bio!.value).toBe("Saved bio");
    expect(f.form.elements.games_text!.value).toBe("Go\nChess");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("9 of 1000 characters");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe("2 of 20 games, 8 of 1700 characters");
    expect(f.byId(BIO_HINT_ID)).not.toBeNull();
    expect(f.byId(GAMES_HINT_ID)).not.toBeNull();
    expect(f.form.elements.bio!.getAttribute("maxlength")).toBeNull();
    expect(f.form.elements.games_text!.getAttribute("maxlength")).toBeNull();
  });
});

describe("island save-path refusals keep values, counts and hints", () => {
  it("client-side refusal of over-budget input saves nothing and preserves feedback", () => {
    const f = fixture();
    f.type("bio", "a".repeat(1001));
    f.type("games_text", "g".repeat(81));
    f.form.dispatch("submit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.form.elements.bio!.value).toBe("a".repeat(1001));
    expect(f.form.elements.games_text!.value).toBe("g".repeat(81));
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("1001 of 1000 characters (1 over the limit)");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe(
      "1 of 20 games, 81 of 1700 characters, line 1 over 80 characters",
    );
    expect(f.root.querySelector('[data-testid="profile-error"]')).not.toBeNull();
    expect(f.form.elements.bio!.getAttribute("aria-describedby")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error`,
    );
    expect(f.form.elements.games_text!.getAttribute("aria-describedby")).toBe(
      `${GAMES_HINT_ID} ${GAMES_COUNT_ID} profile-games-text-error`,
    );
  });

  it("a 422 wires errors after hint+count tokens without touching drafts or counts", async () => {
    const f = fixture();
    f.type("bio", "draft bio");
    f.type("games_text", "Go");
    f.form.dispatch("submit");
    f.requests[0]!.resolve(
      refused({
        bio: "Keep your bio to 1000 characters or fewer.",
        games: "Add no more than 20 games.",
      }),
    );
    await flush();
    await flush();
    expect(f.form.elements.bio!.value).toBe("draft bio");
    expect(f.form.elements.games_text!.value).toBe("Go");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("9 of 1000 characters");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe("1 of 20 games, 2 of 1700 characters");
    expect(f.form.elements.bio!.getAttribute("aria-describedby")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID} profile-bio-error`,
    );
    expect(f.form.elements.games_text!.getAttribute("aria-describedby")).toBe(
      `${GAMES_HINT_ID} ${GAMES_COUNT_ID} profile-games-text-error`,
    );
  });

  it("an accepted save clears field errors while hints and counts stay", async () => {
    const f = fixture();
    f.type("bio", "draft bio ");
    f.type("games_text", "Go\nChess\n");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("10 of 1000 characters");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe("2 of 20 games, 9 of 1700 characters");
    f.form.dispatch("submit");
    f.requests[0]!.resolve(refused({ bio: "Bad bio." }));
    await flush();
    await flush();
    expect(f.byId("profile-bio-error")).not.toBeNull();
    f.form.dispatch("submit");
    f.requests[1]!.resolve(savedAck());
    await flush();
    await flush();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
    expect(f.form.elements.bio!.getAttribute("aria-invalid")).toBeNull();
    expect(f.form.elements.bio!.getAttribute("aria-describedby")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID}`,
    );
    expect(f.byId(BIO_HINT_ID)?.textContent).toBe(BIO_HINT_COPY);
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("9 of 1000 characters");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe("2 of 20 games, 8 of 1700 characters");
  });

  it("reset after a 422 clears errors, restores counts and keeps hints", async () => {
    const f = fixture();
    f.type("bio", "draft bio");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("9 of 1000 characters");
    f.form.dispatch("submit");
    f.requests[0]!.resolve(refused({ bio: "Bad bio." }));
    await flush();
    await flush();
    expect(f.byId("profile-bio-error")).not.toBeNull();
    await f.cancel();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
    expect(f.form.elements.bio!.value).toBe(SAVED.bio);
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe(SAVED_BIO_COUNT);
    expect(f.byId(BIO_HINT_ID)?.textContent).toBe(BIO_HINT_COPY);
    expect(f.form.elements.bio!.getAttribute("aria-describedby")).toBe(
      `${BIO_HINT_ID} ${BIO_COUNT_ID}`,
    );
  });
});

describe("island ownership: late and pending responses with live counts", () => {
  it("a late 422 after cancel restores neither errors nor stale counts", async () => {
    const f = fixture();
    f.type("bio", "Old invalid write");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("17 of 1000 characters");
    f.form.dispatch("submit");
    const pending = f.requests[0]!;
    await f.cancel();
    pending.resolve(refused({ bio: "Old validation error" }));
    await flush();
    await flush();
    expect(f.byId("profile-bio-error")).toBeNull();
    expect(f.root.querySelector('[data-testid="profile-error"]')).toBeNull();
    expect(f.form.elements.bio!.value).toBe(SAVED.bio);
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe(SAVED_BIO_COUNT);
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe(SAVED_GAMES_COUNT);
  });

  it("typing during a pending save refreshes counts without a second request", async () => {
    const f = fixture();
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.type("bio", "hi 🎮");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("4 of 1000 characters");
    expect(f.byId(GAMES_COUNT_ID)?.textContent).toBe(SAVED_GAMES_COUNT);
    f.form.dispatch("submit");
    expect(f.fetch).toHaveBeenCalledTimes(1);
    f.requests[0]!.resolve(savedAck());
    await flush();
    await flush();
    expect(f.form.elements.bio!.value).toBe("hi 🎮");
    expect(f.byId(BIO_COUNT_ID)?.textContent).toBe("4 of 1000 characters");
    expect(f.root.querySelector('[data-testid="profile-saved"]')).not.toBeNull();
  });
});

describe("island leaves timezone and draft ownership alone", () => {
  it("timezone gains no hint or count tokens, even through a refused submit", () => {
    const f = fixture();
    f.type("timezone", "Mars/Olympus");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.byId("profile-timezone-hint")).toBeNull();
    expect(f.byId("profile-timezone-count")).toBeNull();
    expect(f.form.elements.timezone!.getAttribute("aria-describedby")).toBeNull();
    f.form.dispatch("submit");
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.form.elements.timezone!.getAttribute("aria-describedby")).toBe(
      "profile-timezone-error",
    );
    expect(f.byId("profile-timezone-hint")).toBeNull();
    expect(f.byId("profile-timezone-count")).toBeNull();
  });
});
