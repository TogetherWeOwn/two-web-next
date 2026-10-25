// Builder-owned pins for the two native-share behaviors the acceptance
// browser suite exercises but never textually pins: the exact failure
// guidance and the separator staying hidden until enhancement. Kept out of
// ci/event-native-share-browser.test.mjs on purpose: that file is
// Test-author owned and consumed unchanged.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { nativeShareFixture, SHARE_VIEWS } from "./fixtures/event-native-share";

const island = readFileSync(
  new NodeURL("../public/islands/event-share.js", import.meta.url),
  "utf8",
);
const FAILURE_GUIDANCE = "Sharing didn't complete — Copy link is still available.";
const TITLE = 'Chess "night" & friends ♟';
const CANONICAL = "https://events.example.test/e/01ARZ3NDEKTSV4RRFFQ69G5FAV";

type ShareBehavior = "success" | "cancel" | "failure" | "sync-failure" | "pending" | "unsupported";

function harness(behavior: ShareBehavior, secure = true) {
  const calls: Array<{ title: string; url: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const attributes = new Map([
    ["data-share-title", TITLE],
    ["data-share-url", CANONICAL],
  ]);
  let click: () => void = () => {};
  const button = {
    hidden: true,
    getAttribute: (name: string) => attributes.get(name),
    addEventListener: (kind: string, fn: () => void) => {
      if (kind === "click") click = fn;
    },
  };
  const status = { textContent: "" };
  const separator = { hidden: true };
  const share =
    behavior === "unsupported"
      ? undefined
      : (payload: { title: string; url: string }) => {
          calls.push({ ...payload });
          if (behavior === "pending") return gate.then(() => undefined);
          if (behavior === "cancel")
            return Promise.reject(new DOMException("User cancelled", "AbortError"));
          if (behavior === "failure")
            return Promise.reject(new DOMException("Fixture share refused", "NotAllowedError"));
          if (behavior === "sync-failure") throw new TypeError("Fixture synchronous share failure");
          return Promise.resolve(undefined);
        };
  runInNewContext(island, {
    document: {
      querySelector: (selector: string) => {
        if (selector === "[data-native-share]") return button;
        if (selector === "[data-native-share-status]") return status;
        if (selector === "[data-native-share-sep]") return separator;
        return null;
      },
    },
    window: { isSecureContext: secure },
    navigator: { share },
  });
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    button,
    status,
    separator,
    calls,
    async activate() {
      click();
      await flush();
      await flush();
    },
    async settlePending() {
      release();
      await flush();
      await flush();
    },
  };
}

describe("event-share island failure guidance", () => {
  it.each(["failure", "sync-failure"] as const)(
    "shows the exact Copy-link guidance after a %s without claiming success",
    async (behavior) => {
      const h = harness(behavior);
      expect(h.button.hidden).toBe(false);
      await h.activate();
      expect(h.calls).toHaveLength(1);
      expect(h.calls[0]).toEqual({ title: TITLE, url: CANONICAL });
      expect(h.status.textContent).toBe(FAILURE_GUIDANCE);
      // Recovery: the button is usable for a fresh explicit gesture.
      await h.activate();
      expect(h.calls).toHaveLength(2);
      expect(h.status.textContent).toBe(FAILURE_GUIDANCE);
    },
  );

  it("stays silent on AbortError cancellation", async () => {
    const h = harness("cancel");
    await h.activate();
    expect(h.calls).toHaveLength(1);
    expect(h.status.textContent).toBe("");
  });

  it("clears the status on success", async () => {
    const h = harness("success");
    await h.activate();
    expect(h.calls).toHaveLength(1);
    expect(h.status.textContent).toBe("");
  });

  it("ignores duplicate activations while a share is pending", async () => {
    const h = harness("pending");
    await h.activate();
    await h.activate();
    expect(h.calls).toHaveLength(1);
    expect(h.status.textContent).toBe("");
    await h.settlePending();
    await h.activate();
    expect(h.calls).toHaveLength(2);
  });
});

describe("event-share island reveal gate", () => {
  it("reveals the button and separator only when the device share is callable", () => {
    const h = harness("success");
    expect(h.button.hidden).toBe(false);
    expect(h.separator.hidden).toBe(false);
  });

  it("leaves the button and separator hidden when Web Share is unsupported", async () => {
    const h = harness("unsupported");
    expect(h.button.hidden).toBe(true);
    expect(h.separator.hidden).toBe(true);
    await h.activate();
    expect(h.status.textContent).toBe("");
  });

  it("leaves the button and separator hidden in an insecure context", () => {
    const h = harness("success", false);
    expect(h.button.hidden).toBe(true);
    expect(h.separator.hidden).toBe(true);
  });

  it("no-ops without throwing when the page has no Share control", () => {
    expect(() =>
      runInNewContext(island, {
        document: { querySelector: () => null },
        window: { isSecureContext: true },
        navigator: { share: () => Promise.resolve() },
      }),
    ).not.toThrow();
  });
});

describe.each(SHARE_VIEWS)("%s native Share separator markup", (view) => {
  it("keeps the separator and button hidden in SSR so unsupported and no-JS clients see no orphan", async () => {
    const fixture = await nativeShareFixture(view);
    expect(fixture.status).toBe(200);
    const separators =
      fixture.html.match(/<span\b[^>]*data-native-share-sep[^>]*>[\s\S]*?<\/span>/g) ?? [];
    expect(separators).toHaveLength(1);
    const separator = separators[0] ?? "";
    expect(separator).toMatch(/(?:^|\s)hidden(?:\s|=|>|\/)/);
    expect(separator).toContain("·");
    const buttons = fixture.html.match(/<button\b[^>]*data-native-share[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0] ?? "").toMatch(/(?:^|\s)hidden(?:\s|=|>|\/)/);
  });

  it("renders no separator or share status for drafts", async () => {
    const fixture = await nativeShareFixture(view, { viewer: "moderator", status: "draft" });
    expect(fixture.html).not.toContain("data-native-share-sep");
    expect(fixture.html).not.toContain("data-native-share-status");
  });
});
