import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// Exercise both the editable source and shipped binder. Reads ignore abort so
// late completions must remain silent through ownership, not transport luck.
function browser(path: string) {
  type Handler = (event: any) => void;
  function node(textContent = "") {
    const attributes = new Map<string, string>();
    const listeners = new Map<string, Handler>();
    return {
      textContent,
      hidden: false,
      value: "",
      childNodes: ["last-good"],
      listeners,
      attributes,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name) ?? null,
      removeAttribute: (name: string) => attributes.delete(name),
      addEventListener: (type: string, handler: Handler) => listeners.set(type, handler),
    };
  }
  const form = node();
  const input = Object.assign(node(), { closest: () => form });
  const game = node();
  const content = node();
  const skeleton = node("Loading events…");
  skeleton.hidden = true;
  const feedback = node();
  const month = node("October 2030");
  const live = [node(), node(), node(), month];
  const ids = [
    "events-view-status",
    "events-search-status",
    "events-past-status",
    "calendar-month-status",
  ];
  const root = Object.assign(node(), {
    dataset: { searchMaxLength: "255", loadError: "Calendar unavailable" },
    contains: () => true,
    querySelector(selector: string) {
      if (selector === '[data-testid="events-loading"]') return skeleton;
      if (selector === '[data-testid="events-search"]') return input;
      if (selector === '[data-cal-zone="content"]') return content;
      if (selector === "[data-cal-feedback]") return feedback;
      if (selector === 'select[name="game"]') return game;
      const id = /data-testid="([^"]+)"/.exec(selector)?.[1];
      return id ? (live[ids.indexOf(id)] ?? null) : null;
    },
    querySelectorAll: () => [content],
  });
  const requests: { signal: AbortSignal; reject: (error: Error) => void }[] = [];
  const timers = new Map<number, { ms: number; run: () => void }>();
  let timer = 0;
  runInNewContext(readFileSync(new NodeURL(path, import.meta.url), "utf8"), {
    URL,
    AbortController,
    document: { querySelector: () => root },
    window: {
      location: {
        href: "https://calendar.example.test/events",
        origin: "https://calendar.example.test",
      },
      addEventListener() {},
    },
    setTimeout(run: () => void, ms: number) {
      timers.set(++timer, { ms, run });
      return timer;
    },
    clearTimeout: (id: number) => timers.delete(id),
    fetch(_url: string, init: { signal: AbortSignal }) {
      return new Promise((_resolve, reject) => requests.push({ signal: init.signal, reject }));
    },
  });
  return {
    root,
    month,
    content,
    skeleton,
    feedback,
    requests,
    navigate() {
      const link = {
        href: "https://calendar.example.test/events?view=calendar&month=2030-11",
        target: "",
        hasAttribute: () => false,
      };
      root.listeners.get("click")!({
        button: 0,
        target: { closest: () => link },
        preventDefault() {},
      });
    },
    type() {
      input.value += "c";
      input.listeners.get("input")!({});
    },
    changeGame() {
      game.value = "Chess";
      game.listeners.get("change")!({});
    },
    search() {
      for (const [id, task] of timers) {
        if (task.ms !== 300) continue;
        timers.delete(id);
        task.run();
      }
    },
  };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const path of [
  "../assets/islands/events-calendar.js",
  "../public/islands/events-calendar.js",
]) {
  describe(`loading announcement release: ${path}`, () => {
    for (const cancel of ["type", "changeGame"] as const) {
      it(`restores the month when ${cancel} cancels a search that superseded navigation`, async () => {
        const b = browser(path);
        b.navigate();
        expect(b.month.textContent).toBe("Loading events…");
        b.type();
        b.search();
        expect(b.requests).toHaveLength(2);
        expect(b.requests[0]!.signal.aborted).toBe(true);
        b[cancel]();
        expect(b.requests[1]!.signal.aborted).toBe(true);
        expect(b.root.getAttribute("aria-busy")).toBeNull();
        expect(b.skeleton.hidden).toBe(true);
        expect(b.content.hidden).toBe(false);
        expect(b.month.textContent).toBe("October 2030");
        // Abandoned transports cannot put their old loading message back.
        for (const request of b.requests) request.reject(new Error("late failure"));
        await settle();
        expect(b.month.textContent).toBe("October 2030");
        expect(b.feedback.textContent).toBe("");
        expect(b.content.childNodes).toEqual(["last-good"]);
      });
    }

    it("restores a current aborted navigation when its busy state releases", async () => {
      const b = browser(path);
      b.navigate();
      b.requests[0]!.reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      await settle();
      expect(b.root.getAttribute("aria-busy")).toBeNull();
      expect(b.month.textContent).toBe("October 2030");
      expect(b.feedback.textContent).toBe("");
    });
  });
}
