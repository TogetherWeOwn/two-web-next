// Builder-owned regression: a refused draft must not depend on a later DB read.
import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import {
  featuredSaveBaseline,
  getFeatured,
  StaleFeaturedSaveError,
  updateFeatured,
} from "../src/admin/store";
import type { Db } from "../src/db/index";
import type { EnvWithAdminDb } from "../src/admin/db";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { savedForm } from "./helpers/featured-save-document";
import { featuredEditorDocument } from "./helpers/featured-editor-document";

vi.mock("../src/admin/store", async (original) => ({
  ...(await original<typeof import("../src/admin/store")>()),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  recordAccess: vi.fn().mockResolvedValue(true),
}));
const row = {
  id: 1,
  legacyId: null,
  title: "Before",
  body: null,
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: false,
  position: 0,
  startsAt: null,
  endsAt: null,
  startsAtText: null,
  endsAtText: null,
  createdBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  ADMIN_DB: {} as Db,
};
beforeEach(() => vi.clearAllMocks());
describe("featured conflict document", () => {
  it.each(["ECONNRESET", "57014"])(
    "retains the draft when any post-conflict reread would fail (%s)",
    async (code) => {
      const sessions = createMemorySessionStore();
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: "333333333333333333",
        username: "moderator",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date("2035-01-01T00:00:00Z"),
      });
      const cookie = (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      vi.mocked(getFeatured)
        .mockResolvedValueOnce(row)
        .mockRejectedValue(Object.assign(new Error("reread unavailable"), { code }));
      // assign() keeps this test executable before the error gains its typed snapshot.
      vi.mocked(updateFeatured).mockRejectedValue(
        Object.assign(new StaleFeaturedSaveError(row), {
          current: { ...row, title: "Locked saved version" },
        }),
      );
      const response = await adminApp(sessions).request(
        "/featured/1",
        {
          method: "POST",
          headers: { cookie, origin: env.APP_URL },
          body: new URLSearchParams({
            title: "Complete refused draft",
            body: "Keep these notes",
            saved_baseline: await featuredSaveBaseline(row),
          }),
        },
        env,
      );
      expect(response.status).toBe(409);
      const html = await response.text();
      expect(savedForm(html).fields).toMatchObject({
        title: "Complete refused draft",
        body: "Keep these notes",
      });
      expect(html).toContain("Locked saved version");
      expect(getFeatured).toHaveBeenCalledTimes(1);
      expect(html.match(/src="\/islands\/auth-status.js"/g)).toHaveLength(1);
      expect(response.headers.get("cache-control")).toBe("private, no-store");

      // This real 409 has no field errors: deleting only `|| conflict` must
      // lose protection before any new input, not be rescued by validation.
      const browser = featuredEditorDocument(html, { path: "/admin/featured/1" });
      expect(browser.querySelector("[data-admin-validation-summary]")).toBeNull();
      expect(
        browser.querySelector('[data-testid="featured-save-conflict"]')?.getAttribute("role"),
      ).toBe("alert");
      expect(browser.depart()).toMatchObject({ defaultPrevented: true, returnValue: "" });
      expect(browser.values()).toMatchObject({
        title: "Complete refused draft",
        body: "Keep these notes",
      });
      expect(browser.values()).toEqual(savedForm(html).fields);
      const save = browser.querySelector('[data-testid="save-featured"]');
      expect(save?.getAttribute("type")).toBe("submit");
      expect(save?.hasAttribute("disabled")).toBe(false);
      expect(browser.submit().defaultPrevented).toBe(false);
      expect(browser.editor.getAttribute("aria-busy")).toBe("true");
      expect(browser.depart().defaultPrevented).toBe(false);
      expect(browser.values()).toEqual(savedForm(html).fields);
    },
  );
});
