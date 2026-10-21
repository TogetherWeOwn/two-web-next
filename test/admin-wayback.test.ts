// Unit pins for the admin 429 way-back mapping: every throttled admin write
// resolves to the admin GET form it came from, and non-admin paths resolve
// to nothing. Pure string matching — no session, cookie or DB reads — so the
// link stays offerable during the outage it reports.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adminWayBack, adminWayBackForStatus } from "../src/admin-wayback";

describe("adminWayBack", () => {
  it("maps event create to the create form", () => {
    expect(adminWayBack("/admin/events")).toEqual({
      href: "/admin/events/new",
      label: "Back to the new event form",
    });
  });

  it("maps event update to the event editor", () => {
    expect(adminWayBack("/admin/events/game-night")).toEqual({
      href: "/admin/events/game-night",
      label: "Back to the event editor",
    });
  });

  it.each(["publish", "cancel", "rsvp-pause", "rsvp-reopen"])(
    "maps event lifecycle action %s to the event editor",
    (action) => {
      expect(adminWayBack(`/admin/events/game-night/${action}`)).toEqual({
        href: "/admin/events/game-night",
        label: "Back to the event editor",
      });
    },
  );

  it("maps featured create to the create form", () => {
    expect(adminWayBack("/admin/featured")).toEqual({
      href: "/admin/featured/new",
      label: "Back to the new featured form",
    });
  });

  it("maps featured update to the featured editor", () => {
    expect(adminWayBack("/admin/featured/7")).toEqual({
      href: "/admin/featured/7",
      label: "Back to the featured editor",
    });
  });

  it("maps featured delete to the featured editor (the refused delete changed nothing)", () => {
    expect(adminWayBack("/admin/featured/7/delete")).toEqual({
      href: "/admin/featured/7",
      label: "Back to the featured editor",
    });
  });

  it("maps queue redispatch to the preview the moderator acted from", () => {
    expect(adminWayBack("/admin/queue/failed/9/redispatch")).toEqual({
      href: "/admin/queue/failed/9/preview",
      label: "Back to the queue preview",
    });
  });

  it("falls unknown admin paths back to the dashboard", () => {
    expect(adminWayBack("/admin/queue/failed/9/unknown-action")).toEqual({
      href: "/admin",
      label: "Back to the admin dashboard",
    });
  });

  it("tolerates a trailing slash", () => {
    expect(adminWayBack("/admin/events/")).toEqual({
      href: "/admin/events/new",
      label: "Back to the new event form",
    });
  });

  it("resolves nothing outside /admin", () => {
    for (const path of ["/", "/events", "/events/game-night/rsvp", "/auth/discord", "/api/admin"]) {
      expect(adminWayBack(path)).toBeNull();
    }
  });
});

describe("adminWayBackForStatus", () => {
  it("resolves an admin path on 429", () => {
    expect(adminWayBackForStatus(429, "/admin/events/game-night")).toEqual({
      href: "/admin/events/game-night",
      label: "Back to the event editor",
    });
  });

  it.each([400, 403, 404, 410, 413, 500, 503])(
    "resolves nothing on %s even for admin paths",
    (status) => {
      expect(adminWayBackForStatus(status, "/admin/events/game-night")).toBeNull();
    },
  );

  it("resolves nothing off /admin even on 429", () => {
    for (const path of ["/", "/events", "/join"]) {
      expect(adminWayBackForStatus(429, path)).toBeNull();
    }
  });
});

describe("+error.svelte delegates the Kit way back to the status gate", () => {
  it("calls adminWayBackForStatus with the status and page path", () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const page = readFileSync(resolve(root, "web/src/routes/+error.svelte"), "utf8");
    expect(page).toContain("adminWayBackForStatus(status, page.url.pathname)");
  });
});
