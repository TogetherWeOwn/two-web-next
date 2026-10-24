// TEST AUTHOR OWNED. Consume unchanged with the implementation; never merge RED alone.
// Baseline: 2b4f1902e096d969ad4a909a085fb6e221ddfc3a. Fixtures only, no SQL/network.
//
// U3.1 origin: all eight normalized inventory fields survive existing row/edit links.
// U3.2 navigation: native named Back/Cancel; save stays on edit with origin intact.
// U3.3 lifecycle: publish/cancel/pause/reopen return to inventory only when originated there.
// U3.4 refusal: validation/stale/unavailable keep origin without success or automatic resend.
// U3.5 hostile transport: only bounded allowlisted list state, no arbitrary return destination.
// U3.6 controls: admission, private/no-store, fixed read/audit counts and shipped island guards.
// U3.7 browser: e2e/admin-event-inventory-return.spec.ts executes keyboard/no-JS and dirty/pending.
// UI design/screenshots/quality budgets remain Builder delivery obligations, not claimed here.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  compileInventoryReturn,
  editPath,
  forms,
  inventory,
  key,
  links,
  origin,
  post,
  rowLink,
  sameInventory,
  type Harness,
} from "./helpers/admin-event-inventory-return";
import { eventEditorBrowser } from "./helpers/admin-event-editor";

let h: Harness;
const network = vi.fn(() => {
  throw new Error("U3 fixture attempted network");
});
beforeAll(async () => {
  h = await compileInventoryReturn();
});
afterAll(() => h?.dispose());
afterEach(() => vi.unstubAllGlobals());
beforeEach(() => {
  h.reset();
  vi.stubGlobal("fetch", network);
  network.mockClear();
});

function back(html: string) {
  return links(html).find((link) => /^Back to these event results$/i.test(link.text));
}
function assertBack(html: string, expected = inventory) {
  expect(
    sameInventory(back(html)?.href ?? null, expected),
    "U3.2_CONTEXTUAL_BACK: native Back to these event results retains the inventory",
  ).toBe(true);
}
function assertCancel(html: string, expected = inventory) {
  const cancel = links(html).find((link) => link.text === "Cancel");
  expect(
    sameInventory(cancel?.href ?? null, expected),
    "U3.2_CONTEXTUAL_CANCEL: Cancel returns to the same results",
  ).toBe(true);
}
async function editor(twin: "Hono" | "Kit", listPath = inventory) {
  const list = await h.document(twin, listPath);
  const path = rowLink(list);
  return { path, html: await h.document(twin, path) };
}
async function hasRecovery(html: string, twin: "Hono" | "Kit", expected = inventory) {
  if (links(html).some((link) => sameInventory(link.href, expected))) return true;
  for (const link of links(html)) {
    if (new URL(link.href ?? "", origin).pathname !== editPath) continue;
    const edit = await h.document(twin, link.href!);
    if (sameInventory(back(edit)?.href ?? null, expected)) return true;
  }
  return false;
}
function editorForm(html: string) {
  const found = forms(html).find((form) => form.html.includes("data-event-editor"));
  expect(found, "fixture has a real native edit form").toBeDefined();
  return found!;
}
function actionForm(html: string, action: string) {
  const found = forms(html).find(
    (form) => new URL(form.action, origin).pathname === `${editPath}/${action}`,
  );
  expect(found, `fixture has the existing ${action} form`).toBeDefined();
  return found!;
}
function safeInventory(href: string | null) {
  expect(href).toMatch(/^\/admin\/events(?:\?|$)/);
  const url = new URL(href!, origin);
  expect(url.origin).toBe(origin);
  expect(url.hash).toBe("");
  expect(href!.length).toBeLessThan(2048);
  const allowed = ["q", "status", "series", "fill", "rsvp_open", "sort", "order", "page"];
  for (const name of url.searchParams.keys()) {
    expect(allowed).toContain(name);
    expect(url.searchParams.getAll(name)).toHaveLength(1);
  }
  expect((url.searchParams.get("q") ?? "").length).toBeLessThanOrEqual(128);
}
function privateResponse(response: Response) {
  expect(response.headers.get("cache-control")).toContain("private");
  expect(response.headers.get("cache-control")).toContain("no-store");
}

for (const twin of ["Hono", "Kit"] as const) {
  describe(`${twin}: inventory-origin round trip`, () => {
    it("U3.1/U3.2 combined filters, escaped q, sort/order/page → edit → native Back and Cancel", async () => {
      const { html } = await editor(twin);
      // The selector intentionally ignores the fixed section/breadcrumb link.
      assertBack(html);
      assertCancel(html);
      expect(html).not.toContain("<night>");
      expect(h.state.queries).toEqual(["edit:0", "edit:1", "edit:2"]);
      expect(network).not.toHaveBeenCalled();
    });

    it("U3.1 every existing row edit link carries the same origin, not just the title link", async () => {
      const html = await h.document(twin, inventory);
      const edits = links(html).filter(
        (link) => new URL(link.href ?? "", origin).pathname === editPath,
      );
      expect(edits.length).toBeGreaterThanOrEqual(1);
      for (const link of edits) assertBack(await h.document(twin, link.href!));
    });

    it("U3.2 native successful save remains on the existing edit route and retains Back/Cancel", async () => {
      const { html } = await editor(twin);
      const form = editorForm(html);
      form.fields.set("title", "Saved fixture title");
      const response = await h.request(form.action, post(form));
      expect(response.status).toBe(303);
      privateResponse(response);
      const location = response.headers.get("location");
      expect(new URL(location!, origin).pathname).toBe(editPath);
      expect(h.state.writes.map((write) => write.operation)).toEqual(["save"]);
      const saved = await h.document(twin, location!);
      assertBack(saved);
      assertCancel(saved);
      expect(network).not.toHaveBeenCalled();
    });

    for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
      it(`U3.3 inventory ${action} returns to these results after exactly one existing write`, async () => {
        h.state.event.status = action === "publish" ? "draft" : "published";
        h.state.event.rsvpOpen = action !== "rsvp-reopen";
        const source =
          action === "publish" ? inventory.replace("status=published", "status=draft") : inventory;
        const html = await h.document(twin, source);
        const form = actionForm(html, action);
        const response = await h.request(form.action, post(form));
        expect(response.status).toBe(303);
        privateResponse(response);
        expect(h.state.writes.map((write) => write.operation)).toEqual([action]);
        expect(
          sameInventory(response.headers.get("location"), source),
          "U3.3_LOST_LIFECYCLE_ORIGIN: successful inventory action returns to normalized inventory",
        ).toBe(true);
        expect(network).not.toHaveBeenCalled();
      });

      it(`U3.3 edit-origin ${action} also returns to the original results`, async () => {
        h.state.event.status = action === "publish" ? "draft" : "published";
        h.state.event.rsvpOpen = action !== "rsvp-reopen";
        const source =
          action === "publish" ? inventory.replace("status=published", "status=draft") : inventory;
        const { html } = await editor(twin, source);
        const form = actionForm(html, action);
        form.fields.append("member_id", "private-marker");
        form.fields.append("auth_token", "opaque-marker");
        const response = await h.request(form.action, post(form));
        expect(response.status).toBe(303);
        expect(h.state.writes.map((write) => write.operation)).toEqual([action]);
        expect(
          sameInventory(response.headers.get("location"), source),
          "U3.3_LOST_EDITOR_ACTION_ORIGIN",
        ).toBe(true);
      });

      it(`U3.3 direct ${action} preserves the existing edit redirect default`, async () => {
        h.state.event.status = action === "publish" ? "draft" : "published";
        h.state.event.rsvpOpen = action !== "rsvp-reopen";
        const html = await h.document(twin, editPath);
        const form = actionForm(html, action);
        const response = await h.request(form.action, post(form));
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(editPath);
        expect(h.state.writes.map((write) => write.operation)).toEqual([action]);
      });
    }

    it("U3.2 direct/bookmarked edit and direct save keep their fixed Cancel fallback", async () => {
      const html = await h.document(twin, editPath);
      expect(links(html).find((link) => link.text === "Cancel")?.href).toBe("/admin/events");
      const form = editorForm(html);
      const response = await h.request(form.action, post(form));
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(editPath);
    });

    it("U3.4 parser-rejected save keeps draft and origin without calling a writer", async () => {
      const { html } = await editor(twin);
      const form = editorForm(html);
      form.fields.set("title", "");
      const response = await h.request(form.action, post(form));
      expect(response.status).toBe(422);
      privateResponse(response);
      expect(response.headers.get("location")).toBeNull();
      expect(h.state.writes).toEqual([]);
      const rejected = await response.text();
      expect(rejected).toContain("data-event-draft");
      expect(rejected).toContain("data-admin-validation-summary");
      assertBack(rejected);
      assertCancel(rejected);
    });

    for (const refusal of ["validation", "stale", "unavailable"] as const) {
      it(`U3.4 ${refusal} save keeps origin and never silently retries`, async () => {
        const { html } = await editor(twin);
        const form = editorForm(html);
        h.state.refusal = refusal;
        const response = await h.request(form.action, post(form));
        expect(response.status).toBe(refusal === "unavailable" ? 503 : 422);
        privateResponse(response);
        expect(response.headers.get("location")).toBeNull();
        expect(h.state.writes.map((write) => write.operation)).toEqual(["save"]);
        const rejected = await response.text();
        expect(await hasRecovery(rejected, twin), "U3.4_LOST_SAVE_REFUSAL_ORIGIN").toBe(true);
        expect(network).not.toHaveBeenCalled();
      });

      it(`U3.4 ${refusal} lifecycle response retains usable origin, never redirects as success`, async () => {
        h.state.event.status = "draft";
        const source = inventory.replace("status=published", "status=draft");
        const html = await h.document(twin, source);
        const form = actionForm(html, "publish");
        h.state.refusal = refusal;
        const response = await h.request(form.action, post(form));
        expect(response.status).toBe(refusal === "unavailable" ? 503 : 422);
        expect(response.headers.get("location")).toBeNull();
        privateResponse(response);
        const rejected = await response.text();
        expect(h.state.writes.map((write) => write.operation)).toEqual(["publish"]);
        expect(
          await hasRecovery(rejected, twin, source),
          "U3.4_LOST_REFUSAL_ORIGIN: an honest failure still offers native results return",
        ).toBe(true);
        expect(network).not.toHaveBeenCalled();
      });
    }

    it("U3.5 normalizes first-wins duplicates, unknown enum/page, Unicode and unknown/private fields", async () => {
      const source =
        "/admin/events?q=+%E2%99%9F%00+%26+%3Cimg%3E+&q=discarded&status=invalid&series=standalone&fill=unlimited&rsvp_open=0&sort=invalid&order=invalid&page=9007199254740992&member_id=private-marker&token=opaque-marker&unknown=discard-me";
      const expected =
        "/admin/events?q=%E2%99%9F+%26+%3Cimg%3E&series=standalone&fill=unlimited&rsvp_open=0&sort=starts_at&order=desc";
      const { html, path } = await editor(twin, source);
      assertBack(html, expected);
      assertCancel(html, expected);
      expect(decodeURIComponent(path)).not.toMatch(
        /private-marker|opaque-marker|discard-me|discarded/,
      );
      expect(html).not.toContain("<img>");
    });

    it("U3.5 a 129-character search is absent rather than truncated in the returned inventory", async () => {
      const source = `/admin/events?q=${"x".repeat(129)}&sort=status&order=asc&page=4`;
      const { html } = await editor(twin, source);
      assertBack(html, "/admin/events?sort=status&order=asc&page=4");
    });

    it("U3.6 origin does not change parsed write input, actor/key, or existing confirmation/version carriers", async () => {
      const direct = editorForm(await h.document(twin, editPath));
      const directResponse = await h.request(direct.action, post(direct));
      expect(directResponse.status).toBe(303);
      const directArgs = h.state.writes[0]!.args.slice(1);
      const { html } = await editor(twin);
      const contextual = editorForm(html);
      for (const [name, value] of direct.fields) expect(contextual.fields.get(name)).toBe(value);
      const response = await h.request(contextual.action, post(contextual));
      expect(response.status).toBe(303);
      expect(h.state.writes[1]!.args.slice(1)).toEqual(directArgs);
      expect(h.state.writes).toHaveLength(2);
    });

    it("U3.6 adding origin causes no additional inventory/editor reads or audit records", async () => {
      const direct = await h.document(twin, editPath);
      const reads = [...h.state.queries];
      const auditsBefore = h.state.audits.length;
      await h.document(twin, inventory);
      const afterList = h.state.audits.length;
      const list = await h.document(twin, inventory);
      expect(h.state.queries).toEqual(["bound", "list:0", "list:1"]);
      const beforeEdit = h.state.audits.length;
      await h.document(twin, rowLink(list));
      expect(h.state.queries).toEqual(reads);
      expect(h.state.audits.length - beforeEdit).toBe(auditsBefore);
      // Empty roster and non-sensitive inventory read no member subjects.
      expect(afterList - auditsBefore).toBe(0);
      expect(direct).toContain("data-event-editor");
      expect(network).not.toHaveBeenCalled();
    });

    it("U3.5 hostile discovered origin transport can never become an external/wrong-path redirect", async () => {
      const html = await h.document(twin, inventory);
      const path = rowLink(html);
      const params = new URL(path, origin).searchParams;
      const names = [...new Set(params.keys())];
      // Baseline has no carrier. Common unknown names are passing refusal controls,
      // not evidence that a nonexistent origin transport was exercised.
      const carriers = names.length ? names : ["return_to", "return", "from"];
      for (const hostile of [
        "https://evil.example/steal",
        "//evil.example/steal",
        "/admin/members?token=opaque-marker",
        `/admin/events?q=${"x".repeat(4096)}`,
      ]) {
        h.state.writes.length = 0;
        const url = new URL(editPath, origin);
        for (const name of carriers) url.searchParams.append(name, hostile);
        let edited: string;
        try {
          edited = await h.document(twin, url.pathname + url.search);
        } catch (error) {
          expect([400, 404, 413, 414, 422]).toContain((error as { status?: number }).status);
          expect(h.state.writes).toEqual([]);
          continue;
        }
        for (const link of links(edited).filter((link) =>
          /^(Cancel|Back to these event results)$/i.test(link.text),
        )) {
          safeInventory(link.href);
        }
        const form = editorForm(edited);
        for (const name of carriers) {
          form.fields.append(name, hostile);
          form.fields.append(name, inventory);
        }
        const response = await h.request(form.action, post(form));
        const location = response.headers.get("location");
        if (location) {
          expect(location.startsWith("/") && !location.startsWith("//")).toBe(true);
          expect(new URL(location, origin).pathname).toBe(editPath);
          expect(location.length).toBeLessThan(2048);
          const saved = await h.document(twin, location);
          for (const link of links(saved).filter((link) =>
            /^(Cancel|Back to these event results)$/i.test(link.text),
          ))
            safeInventory(link.href);
        } else expect([400, 404, 413, 414, 422]).toContain(response.status);
      }
    });
  });
}

it("U3.6 real Hono moderator admission and Kit parent refusal precede inventory context reads", async () => {
  for (const member of [false, true]) {
    const response = await h.denied(
      `${editPath}?return_to=${encodeURIComponent(inventory)}`,
      member,
    );
    expect(response.status).toBe(member ? 403 : 302);
    expect(h.state.queries).toEqual([]);
    expect(h.state.audits).toEqual([]);
    await expect(h.kitDenied(editPath, member ? 403 : 302)).rejects.toMatchObject({
      status: member ? 403 : 302,
    });
    expect(h.state.queries).toEqual([]);
  }
});

it("U3.6 the shipped island retains dirty departure, one pending save and its 10-second bound", () => {
  const browser = eventEditorBrowser({ path: editPath });
  expect(browser.navigate("unrelated").preventDefault).not.toHaveBeenCalled();
  browser.values.set("title", "Unsaved fixture");
  browser.input();
  expect(browser.navigate("unrelated").preventDefault).toHaveBeenCalledOnce();
  expect(browser.submit().defaultPrevented).toBe(false);
  expect(browser.editor.attrs["aria-busy"]).toBe("true");
  expect(browser.submit().defaultPrevented).toBe(true);
  expect(browser.pendingTimers()).toEqual([10000]);
  browser.advanceTimers(9999);
  expect(browser.editor.attrs["aria-busy"]).toBe("true");
  browser.advanceTimers(10000);
  expect(browser.editor.attrs["aria-busy"]).toBeUndefined();
  expect(browser.pendingTimers()).toEqual([]);
  browser.windowListeners.get("pageshow")?.({ preventDefault: () => undefined });
  expect(browser.editor.attrs["aria-busy"]).toBeUndefined();
  expect(key).toHaveLength(26);
});
