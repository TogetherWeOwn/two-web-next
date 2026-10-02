import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { PAST_EVENTS_COPY } from "../src/islands/contracts";

const binder = readFileSync(
  new NodeURL("../public/islands/past-events.js", import.meta.url),
  "utf8",
);
const ORIGIN = "https://next.example.test";
const MOUNT = '[data-island="past-events"]';
const CANONICAL = 'link[rel="canonical"]';
const OG = 'meta[property="og:url"]';
const ZONES = ["[data-archive-state]", "[data-archive-list]", "[data-archive-pager]"];

class Node {
  childNodes: Node[] = [];
  matches = new Map<string, Node[]>();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  hidden = false;
  textContent = "";
  href = "";
  content = "";
  focused = false;
  constructor(readonly label: string) {}
  querySelectorAll(selector: string) {
    return this.matches.get(selector) ?? [];
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getAttribute(name: string) {
    if (name === "href") return this.href || null;
    if (name === "content") return this.content || null;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  contains(other: Node): boolean {
    return this === other || this.childNodes.some((child) => child.contains(other));
  }
  replaceChildren(...children: Node[]) {
    this.childNodes = children;
  }
  focus() {
    this.focused = true;
  }
}

function archive(page: number) {
  const document = new Node("document");
  const root = new Node("archive");
  const zones = ZONES.map((selector, i) => {
    const zone = new Node(selector);
    zone.childNodes = [new Node(`page ${page}, zone ${i}`)];
    zone.hidden = i === (page === 1 ? 0 : 1);
    root.matches.set(selector, [zone]);
    return zone;
  });
  const heading = new Node("heading");
  const feedback = new Node("feedback");
  root.matches.set("h1", [heading]);
  root.matches.set("[data-archive-feedback]", [feedback]);
  root.childNodes = [...zones, heading, feedback];
  root.dataset = {
    page: String(page),
    totalPages: String(page === 1 ? 3 : 4),
    loadError: PAST_EVENTS_COPY.failed,
  };
  const canonical = new Node("canonical");
  canonical.href = ORIGIN + (page === 1 ? "/events/past" : `/events/past?page=${page}`);
  const og = new Node("og:url");
  og.content = canonical.href;
  document.matches.set(MOUNT, [root]);
  document.matches.set(CANONICAL, [canonical]);
  document.matches.set(OG, [og]);
  return { document, root, zones, heading, feedback, canonical, og };
}

type Response = { ok: boolean; text: () => Promise<string> };
function browser() {
  const live = archive(1);
  const incoming = archive(2);
  const history: string[] = [];
  const reloads: string[] = [];
  const operations: string[] = [];
  const controllers: AbortController[] = [];
  const requests: {
    signal: AbortSignal;
    resolve: (value: Response) => void;
    reject: (error: Error) => void;
  }[] = [];
  const location = {
    origin: ORIGIN,
    href: ORIGIN + "/events/past",
    assign: (href: string) => reloads.push(href),
  };
  let click: (event: unknown) => void = () => {};
  let popstate: () => void = () => {};
  let onImport: (node: Node) => void = () => {};
  Object.assign(live.root, {
    addEventListener: (_type: string, listener: typeof click) => {
      click = listener;
    },
  });
  live.zones.forEach((zone) => {
    zone.replaceChildren = (...children) => {
      operations.push("replace");
      zone.childNodes = children;
    };
  });
  live.heading.focus = () => {
    operations.push("focus");
    live.heading.focused = true;
  };
  const document = Object.assign(live.document, {
    importNode: (node: Node, deep: boolean) => {
      operations.push("import");
      expect(deep).toBe(true);
      onImport(node);
      return new Node(node.label);
    },
  });
  runInNewContext(binder, {
    URL,
    AbortController: class extends AbortController {
      constructor() {
        super();
        controllers.push(this);
      }
    },
    document,
    window: {
      location,
      history: {
        pushState: (_state: unknown, _title: string, url: string) => {
          operations.push("push");
          // History can only observe a fully admitted snapshot.
          expect(live.zones.map((zone) => zone.childNodes[0]!.label)).toEqual(
            incoming.zones.map((zone) => zone.childNodes[0]!.label),
          );
          expect(live.root.dataset.page).toBe(incoming.root.dataset.page);
          expect(live.root.dataset.totalPages).toBe(incoming.root.dataset.totalPages);
          expect(live.canonical.href).toBe(incoming.canonical.href);
          expect(live.og.content).toBe(incoming.og.content);
          history.push(url);
          location.href = ORIGIN + url;
        },
      },
      addEventListener: (_type: string, listener: () => void) => {
        popstate = listener;
      },
    },
    DOMParser: class {
      parseFromString() {
        operations.push("parse");
        return incoming.document;
      }
    },
    fetch: (_url: string, init: { signal: AbortSignal }) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({ signal: init.signal, resolve, reject });
      }),
  });
  function turn(page = 2) {
    const link = Object.assign(new Node("link"), {
      href: `${ORIGIN}/events/past?page=${page}`,
      target: "",
      hasAttribute: () => false,
    });
    live.root.childNodes.push(link);
    click({
      defaultPrevented: false,
      button: 0,
      target: { closest: () => link },
      preventDefault: () => {},
    });
  }
  function finish(index = 0) {
    requests[index]!.resolve({ ok: true, text: async () => "fixture" });
  }
  async function settle() {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  }
  function snapshot() {
    return {
      zones: live.zones.map((zone) => ({ children: zone.childNodes.slice(), hidden: zone.hidden })),
      dataset: { ...live.root.dataset },
      canonical: live.canonical.href,
      og: live.og.content,
      history: history.slice(),
      href: location.href,
    };
  }
  return {
    live,
    incoming,
    history,
    reloads,
    operations,
    requests,
    controllers,
    location,
    turn,
    finish,
    settle,
    snapshot,
    popstate: () => popstate(),
    importWith: (callback: typeof onImport) => {
      onImport = callback;
    },
  };
}

function rejected(b: ReturnType<typeof browser>, snapshot: ReturnType<typeof b.snapshot>) {
  expect(b.snapshot()).toEqual(snapshot);
  b.live.zones.forEach((zone, i) =>
    zone.childNodes.forEach((node, j) => expect(node).toBe(snapshot.zones[i]!.children[j])),
  );
  expect(b.live.feedback.textContent).toBe(PAST_EVENTS_COPY.failed);
  expect(b.live.root.attributes.has("aria-busy")).toBe(false);
  expect(b.live.heading.focused).toBe(false);
  expect(b.operations).not.toContain("replace");
  expect(b.operations).not.toContain("push");
}

describe("PastEvents complete-snapshot admission", () => {
  it.each([CANONICAL, OG, MOUNT])(
    "rejects missing or ambiguous live %s before replacing any zone",
    async (selector) => {
      for (const count of [0, 2]) {
        const b = browser();
        b.turn();
        const node = b.live.document.querySelector(selector)!;
        b.live.document.matches.set(
          selector,
          Array.from({ length: count }, () => node),
        );
        const snapshot = b.snapshot();
        b.finish();
        await b.settle();
        rejected(b, snapshot);
        expect(b.reloads).toEqual([]);
      }
    },
  );

  it.each([...ZONES, "h1", "[data-archive-feedback]"])(
    "rejects missing or ambiguous live %s while a read is pending",
    async (selector) => {
      for (const count of [0, 2]) {
        const b = browser();
        b.turn();
        const node = b.live.root.querySelector(selector)!;
        b.live.root.matches.set(
          selector,
          Array.from({ length: count }, () => node),
        );
        const snapshot = b.snapshot();
        b.finish();
        await b.settle();
        rejected(b, snapshot);
      }
    },
  );

  it.each([CANONICAL, OG, MOUNT, ...ZONES])(
    "rejects missing or ambiguous incoming %s without any visible commit",
    async (selector) => {
      for (const count of [0, 2]) {
        const b = browser();
        const parent = ZONES.includes(selector) ? b.incoming.root : b.incoming.document;
        const node = parent.querySelector(selector)!;
        parent.matches.set(
          selector,
          Array.from({ length: count }, () => node),
        );
        const snapshot = b.snapshot();
        b.turn();
        b.finish();
        await b.settle();
        rejected(b, snapshot);
      }
    },
  );

  it.each(["live", "incoming"] as const)("rejects overlapping %s zones", async (side) => {
    for (const sameNode of [false, true]) {
      const b = browser();
      const page = b[side];
      if (sameNode) page.root.matches.set(ZONES[1]!, [page.zones[0]!]);
      else page.zones[0]!.childNodes.push(page.zones[1]!);
      const snapshot = b.snapshot();
      b.turn();
      b.finish();
      await b.settle();
      rejected(b, snapshot);
    }
  });

  it.each(["live", "incoming"] as const)(
    "rejects %s metadata nested in a replaced zone",
    async (side) => {
      const b = browser();
      b[side].zones[0]!.childNodes.push(b[side].canonical, b[side].og);
      const snapshot = b.snapshot();
      b.turn();
      b.finish();
      await b.settle();
      rejected(b, snapshot);
    },
  );

  it.each(["live", "incoming"] as const)("rejects malformed %s metadata", async (side) => {
    for (const value of [
      "",
      "https://elsewhere.example/events/past",
      `${ORIGIN}/events`,
      `${ORIGIN}/events/past#fragment`,
      `${ORIGIN}/events/past?page=0`,
    ]) {
      const b = browser();
      b[side].canonical.href = value;
      b[side].og.content = value;
      const snapshot = b.snapshot();
      b.turn();
      b.finish();
      await b.settle();
      rejected(b, snapshot);
    }
    const b = browser();
    b[side].og.content = `${ORIGIN}/events/past?page=8`;
    const snapshot = b.snapshot();
    b.turn();
    b.finish();
    await b.settle();
    rejected(b, snapshot);
  });

  it.each([
    { page: "", totalPages: "4" },
    { page: "02", totalPages: "4" },
    { page: "2", totalPages: "-1" },
    { page: "2", totalPages: "" },
    { page: "9007199254740992", totalPages: "4" },
    { page: "2", totalPages: "9007199254740992" },
    { page: "3", totalPages: "4" },
  ])("rejects malformed or canonical-inconsistent incoming datasets %j", async (dataset) => {
    const b = browser();
    Object.assign(b.incoming.root.dataset, dataset);
    const snapshot = b.snapshot();
    b.turn();
    b.finish();
    await b.settle();
    rejected(b, snapshot);
  });

  it.each([1, 2, 3])(
    "stages every import before mutation when import %i throws",
    async (failAt) => {
      const b = browser();
      let imported = 0;
      b.importWith(() => {
        if (++imported === failAt) throw new Error("Cannot import fixture");
      });
      const snapshot = b.snapshot();
      b.turn();
      b.finish();
      await b.settle();
      rejected(b, snapshot);
      expect(imported).toBe(failAt);
    },
  );

  it("commits every zone, hidden flag, dataset and metadata before history and focus", async () => {
    const b = browser();
    b.turn();
    b.finish();
    await b.settle();
    expect(b.operations).toEqual([
      "parse",
      "import",
      "import",
      "import",
      "replace",
      "replace",
      "replace",
      "push",
      "focus",
    ]);
    expect(b.snapshot()).toMatchObject({
      dataset: { page: "2", totalPages: "4" },
      canonical: b.incoming.canonical.href,
      og: b.incoming.og.content,
    });
    b.live.zones.forEach((zone, i) => {
      expect(zone.hidden).toBe(b.incoming.zones[i]!.hidden);
      expect(zone.childNodes[0]).not.toBe(b.incoming.zones[i]!.childNodes[0]);
    });
    expect(b.history).toEqual(["/events/past?page=2"]);
    expect(b.live.feedback.textContent).toBe("");
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
    expect(b.live.heading.focused).toBe(true);
  });

  it("allows empty/out-of-range SSR states with zero total pages", async () => {
    const b = browser();
    b.incoming.root.dataset.totalPages = "0";
    b.turn();
    b.finish();
    await b.settle();
    expect(b.live.root.dataset.totalPages).toBe("0");
    expect(b.history).toHaveLength(1);
  });

  it("ignores a stale response body without clearing the newer read's busy state", async () => {
    const b = browser();
    let resolveBody: (value: string) => void = () => {};
    b.turn();
    b.requests[0]!.resolve({
      ok: true,
      text: () =>
        new Promise((resolve) => {
          resolveBody = resolve;
        }),
    });
    await b.settle();
    b.turn();
    const snapshot = b.snapshot();
    expect(b.requests[0]!.signal.aborted).toBe(true);
    resolveBody("stale fixture");
    await b.settle();
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).toEqual([]);
    expect(b.live.root.attributes.get("aria-busy")).toBe("true");
    expect(b.live.feedback.textContent).toBe("Loading past events…");
    b.finish(1);
    await b.settle();
    const latest = b.snapshot();
    b.finish(0);
    await b.settle();
    expect(b.snapshot()).toEqual(latest);
  });

  it("preserves the complete latest snapshot when an older fetch ignores abort and resolves last", async () => {
    const b = browser();
    b.turn();
    b.turn();
    b.finish(1);
    await b.settle();
    const snapshot = b.snapshot();
    const operations = b.operations.slice();
    b.incoming.zones.forEach((zone) => {
      zone.childNodes = [new Node("stale replacement")];
      zone.hidden = !zone.hidden;
    });
    b.incoming.root.dataset.totalPages = "99";
    b.finish(0);
    await b.settle();
    expect(b.snapshot()).toEqual(snapshot);
    expect(b.operations).toEqual(operations);
    expect(b.live.feedback.textContent).toBe("");
    expect(b.live.root.attributes.has("aria-busy")).toBe(false);
  });

  it.each(["before parsing", "during staging"])(
    "ignores an aborted response %s even when fetch resolves",
    async (timing) => {
      const b = browser();
      const snapshot = b.snapshot();
      b.turn();
      if (timing === "before parsing") b.controllers[0]!.abort();
      else b.importWith(() => b.controllers[0]!.abort());
      b.finish();
      await b.settle();
      expect(b.snapshot()).toEqual(snapshot);
      expect(b.operations).not.toContain("replace");
      expect(b.live.root.attributes.has("aria-busy")).toBe(false);
      expect(b.live.heading.focused).toBe(false);
    },
  );

  it("restores history without pushing and reloads SSR on admission failure", async () => {
    const b = browser();
    b.location.href = `${ORIGIN}/events/past?page=2&utm_source=fixture#archive`;
    b.popstate();
    b.finish();
    await b.settle();
    expect(b.history).toEqual([]);
    expect(b.live.root.dataset.page).toBe("2");
    b.location.href = `${ORIGIN}/events/past`;
    b.popstate();
    b.incoming.document.matches.set(OG, []);
    const snapshot = b.snapshot();
    b.live.heading.focused = false;
    b.operations.length = 0;
    b.finish(1);
    await b.settle();
    rejected(b, snapshot);
    expect(b.reloads).toEqual([`${ORIGIN}/events/past`]);
  });
});
