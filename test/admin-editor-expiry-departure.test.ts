// Departure protection after session expiry: expiry must not disarm the
// dirty guard globally. Only a normal, explicit activation of the expiry
// notice's "Sign in again" recovery link exempts that one departure
// (the one-shot pattern the member-profile island already uses).
// Acceptance-owned: the builder implements against these tests without
// editing this file or test/helpers/admin-event-editor.ts.
import { readFileSync } from "node:fs";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ADMIN_SESSION_EXPIRED_COPY, ADMIN_SESSION_EXPIRED_TESTID } from "../src/islands/contracts";
import { eventEditorBrowser, type ClickInit } from "./helpers/admin-event-editor";

const FEATURED = {
  title: "Friday games",
  body: "Bring a friend.",
  url: "https://example.test/games",
  image_url: "https://cdn.discordapp.com/photo.jpg",
  image_alt: "Friends playing together",
  position: "0",
  starts_at: "",
  ends_at: "",
};

const MOUNTS = [
  { name: "event editor", options: {}, path: "/admin/events/abc" },
  {
    name: "featured editor",
    options: { initial: FEATURED, path: "/admin/featured/1" },
    path: "/admin/featured/1",
  },
] as const;

const DEPARTURES = ["search", "sort", "reload", "unrelated"] as const;

describe.each(MOUNTS)("expired-session departure guard ($name)", ({ options, path }) => {
  it("positive control: a dirty editor prompts before expiry, and the draft survives staying", () => {
    const b = eventEditorBrowser(options);
    b.values.set("title", "Unsaved headline");
    const departure = b.navigate("sort");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    expect(b.values.get("title")).toBe("Unsaved headline");
  });

  it.each(DEPARTURES)(
    "dirty expired editor still prompts before a %s departure, repeatedly",
    (kind) => {
      const b = eventEditorBrowser(options);
      b.values.set("title", "Unsaved headline");
      b.expireSession();
      for (let attempt = 0; attempt < 2; attempt++) {
        const departure = b.navigate(kind);
        expect(departure.preventDefault).toHaveBeenCalledOnce();
        expect(departure.returnValue).toBe("");
      }
      // Staying keeps the draft and the single durable notice.
      expect(b.values.get("title")).toBe("Unsaved headline");
      expect(
        b.created.filter((el) => el.attrs["data-testid"] === ADMIN_SESSION_EXPIRED_TESTID),
      ).toHaveLength(1);
    },
  );

  it.each(DEPARTURES)("clean expired editor does not prompt before a %s departure", (kind) => {
    const b = eventEditorBrowser(options);
    b.expireSession();
    expect(b.navigate(kind).preventDefault).not.toHaveBeenCalled();
  });

  it("an untouched rejected-Save draft stays protected after expiry", () => {
    const b = eventEditorBrowser({ ...options, draft: true });
    b.expireSession();
    expect(b.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  });

  it("a normal Sign in again activation exempts exactly the next departure", () => {
    const b = eventEditorBrowser(options);
    b.values.set("title", "Unsaved headline");
    b.expireSession();
    b.clickRecovery();
    expect(b.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
    // One-shot: if this document survives, the next departure prompts again.
    expect(b.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
    expect(b.values.get("title")).toBe("Unsaved headline");
  });

  it.each([
    ["ctrl-click", { ctrlKey: true }],
    ["meta-click", { metaKey: true }],
    ["shift-click", { shiftKey: true }],
    ["alt-click", { altKey: true }],
    ["middle click", { button: 1 }],
    ["right click", { button: 2 }],
  ] as Array<[string, ClickInit]>)(
    "a %s on Sign in again does not disarm the current-document guard",
    (_label, init) => {
      const b = eventEditorBrowser(options);
      b.values.set("title", "Unsaved headline");
      b.expireSession();
      b.clickRecovery(init);
      expect(b.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
    },
  );

  it("an interrupted recovery activation restores protection once its one-shot window lapses", () => {
    const b = eventEditorBrowser(options);
    b.values.set("title", "Unsaved headline");
    b.expireSession();
    b.clickRecovery();
    // No departure follows the click (loading stopped / navigation aborted):
    // the one-shot reset timer fires and the guard must be armed again.
    b.advanceTimers(0);
    expect(b.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  });

  it("keeps the Save exemption and Save-timeout re-arming after expiry", () => {
    const b = eventEditorBrowser(options);
    b.values.set("title", "Unsaved headline");
    b.expireSession();
    // A Save departure is still exempt, and repeat submits stay locked out.
    expect(b.navigate("save").preventDefault).not.toHaveBeenCalled();
    expect(b.submit().defaultPrevented).toBe(true);
    // After the lock bound lapses with no departure, protection is restored.
    b.fireTimers();
    const departure = b.navigate("unrelated");
    expect(departure.preventDefault).toHaveBeenCalledOnce();
    expect(departure.returnValue).toBe("");
    expect(b.editor.attrs["aria-busy"]).toBeUndefined();
  });

  it("keeps the expiry notice private: no draft contents in its text or recovery URL", () => {
    const secretDraft = "Unsaved headline with private notes";
    const b = eventEditorBrowser(options);
    b.values.set("title", secretDraft);
    b.expireSession(`/auth/recover?next=${encodeURIComponent(path)}`);
    const link = b.recoveryLink();
    expect(link).not.toBeNull();
    expect(link!.textContent).toBe("Sign in again");
    expect(link!.href).toBe(`/auth/recover?next=${encodeURIComponent(path)}`);
    expect(link!.href).not.toContain(encodeURIComponent(secretDraft));
    const notice = b.created.find((el) => el.attrs["data-testid"] === ADMIN_SESSION_EXPIRED_TESTID);
    expect(notice!.textContent).toContain(ADMIN_SESSION_EXPIRED_COPY);
    expect(notice!.textContent).not.toContain(secretDraft);
  });

  it("a hostile recovery detail still falls back to this page's recovery path", () => {
    const b = eventEditorBrowser(options);
    b.values.set("title", "Unsaved headline");
    b.expireSession("//evil.example/auth/recover");
    expect(b.recoveryLink()!.href).toBe(`/auth/recover?next=${encodeURIComponent(path)}`);
    // And the dirty guard still stands behind that safe link.
    expect(b.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  });
});

// Opt in with ADMIN_EDITOR_EXPIRY_BROWSER_TESTS=true after installing
// Playwright Chromium. Every document and asset is a synthetic intercepted
// fixture; no server, network or database.
// ADMIN_EDITOR_EXPIRY_BROWSER_TESTS=true npx vitest run test/admin-editor-expiry-departure.test.ts
describe.skipIf(process.env.ADMIN_EDITOR_EXPIRY_BROWSER_TESTS !== "true")(
  "admin editor expiry departure in Chromium",
  () => {
    let browser: Browser;
    let context: BrowserContext;
    let page: Page;
    const dialogs: string[] = [];

    const documentFor = (path: string) => `<!doctype html><html><body>
      <form method="post" action="${path}" data-event-editor="">
        <label>Title <input name="title" value="Game night" /></label>
        <button type="submit">Save</button>
      </form>
      <script src="/islands/admin-event-editor.js" defer></script>
    </body></html>`;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    // Fresh context/page per test: a correctly-armed dirty guard in one
    // test must not prompt (and, dismissed, abort) the next test's setup
    // navigation.
    beforeEach(async () => {
      dialogs.length = 0;
      context = await browser.newContext();
      page = await context.newPage();
      page.on("dialog", async (dialog) => {
        dialogs.push(dialog.type());
        await dialog.dismiss(); // Stay on the page.
      });
      await page.route("**/*", async (route) => {
        const { pathname } = new URL(route.request().url());
        if (pathname === "/islands/admin-event-editor.js") {
          await route.fulfill({
            contentType: "text/javascript",
            body: readFileSync("public/islands/admin-event-editor.js", "utf8"),
          });
        } else if (pathname === "/auth/recover") {
          await route.fulfill({ contentType: "text/html", body: "<p>recovery landing</p>" });
        } else if (route.request().resourceType() === "document") {
          await route.fulfill({ contentType: "text/html", body: documentFor(pathname) });
        } else {
          await route.fulfill({ status: 404, body: "" });
        }
      });
    });
    afterEach(async () => {
      await context?.close();
    });
    afterAll(async () => {
      await browser?.close();
    });

    async function loadDirtyExpired(path: string) {
      dialogs.length = 0;
      await page.goto(`https://next.example.test${path}`);
      const title = page.locator('input[name="title"]');
      await title.focus();
      await title.press("End");
      await title.pressSequentially(" changed");
      const vetoed = await page.evaluate(
        `(() => {
          const e = new CustomEvent('two:session-expired', {
            cancelable: true,
            detail: { recoveryUrl: '/auth/recover?next=' + encodeURIComponent(location.pathname) },
          });
          window.dispatchEvent(e);
          return e.defaultPrevented;
        })()`,
      );
      expect(vetoed).toBe(true);
      expect(await page.locator('[data-testid="admin-session-expired"]').isVisible()).toBe(true);
    }

    it("dirty expired event editor prompts on reload and staying keeps the draft", async () => {
      await loadDirtyExpired("/admin/events/abc");
      await page.reload({ timeout: 5_000 }).catch(() => null);
      expect(dialogs).toContain("beforeunload");
      expect(await page.locator('input[name="title"]').inputValue()).toBe("Game night changed");
      expect(page.url()).toContain("/admin/events/abc");
    }, 20_000);

    it("dirty expired featured editor prompts on reload and staying keeps the draft", async () => {
      await loadDirtyExpired("/admin/featured/1");
      await page.reload({ timeout: 5_000 }).catch(() => null);
      expect(dialogs).toContain("beforeunload");
      expect(await page.locator('input[name="title"]').inputValue()).toBe("Game night changed");
    }, 20_000);

    it("clean expired editor reloads without a prompt", async () => {
      dialogs.length = 0;
      await page.goto("https://next.example.test/admin/events/abc");
      await page.evaluate(
        `window.dispatchEvent(new CustomEvent('two:session-expired', { cancelable: true, detail: {} }))`,
      );
      await page.reload({ timeout: 5_000 });
      expect(dialogs).toEqual([]);
    }, 20_000);

    it("a normal Sign in again click leaves for recovery without a prompt", async () => {
      await loadDirtyExpired("/admin/events/abc");
      await page.getByRole("link", { name: "Sign in again" }).click();
      await page.waitForURL("**/auth/recover**", { timeout: 5_000 });
      expect(dialogs).toEqual([]);
      expect(await page.locator("p").textContent()).toBe("recovery landing");
    }, 20_000);
  },
);
