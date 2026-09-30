import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { createFeatured, getFeatured, updateFeatured } from "../src/admin/store";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/admin/store")>(),
  createFeatured: vi.fn(),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
}));

const env: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
  FEATURED_IMAGE_HOSTS: "images.unsplash.com",
  // Store operations are mocked: any accidental driver call fails rather than
  // reaching a database. This seam exists already for the admin route tests.
  ADMIN_DB: new Proxy({} as Db, { get: (_, key) => {
    if (key === "then") return undefined; // Async dbFor() checks whether the fixture is a thenable.
    throw new Error("fixture must not query a DB");
  } }),
};

const existing = {
  id: 1, title: "Featured", body: null, url: null, imageUrl: null, imageAlt: null,
  isPublished: false, position: 0, startsAt: null, endsAt: null, createdBy: null,
  createdAt: new Date(0), updatedAt: new Date(0),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getFeatured).mockResolvedValue(existing);
  vi.mocked(createFeatured).mockResolvedValue(existing);
  vi.mocked(updateFeatured).mockResolvedValue(existing);
});

async function post(path: string, imageUrl: string, bindings = env) {
  const store = createMemorySessionStore();
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token), userId: "111", username: "mod", avatar: null,
    member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  return adminApp(store).request(path, {
    method: "POST", headers: { cookie, origin: env.APP_URL },
    body: new URLSearchParams({ title: "Featured", image_url: imageUrl, image_alt: "Players together" }),
  }, bindings);
}

describe("featured create/edit image validation (local fixtures)", () => {
  for (const path of ["/featured", "/featured/1"]) {
    it.each(["http://images.unsplash.com/photo.png", "https://127.0.0.1/photo.png", "https://localhost/photo.png", "https://user:pass@images.unsplash.com/photo.png", "https://unapproved.com/photo.png"])(`${path} returns a field error without writing for %s`, async (url) => {
      const res = await post(path, url);
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("HTTPS on an approved public host");
      expect(html).toContain('name="image_url"');
      expect(createFeatured).not.toHaveBeenCalled();
      expect(updateFeatured).not.toHaveBeenCalled();
    });

    it.each(["localdomain", "localhost.localdomain", "cdn.localhost.localdomain", "alt", "images.alt", "cdn.images.alt"])(`${path} rejects configured reserved namespace %s without writing`, async (host) => {
      const res = await post(path, `https://${host}/photo.png`, { ...env, FEATURED_IMAGE_HOSTS: host });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("HTTPS on an approved public host");
      expect(html).toContain('name="image_url"');
      expect(createFeatured).not.toHaveBeenCalled();
      expect(updateFeatured).not.toHaveBeenCalled();
    });

    it(`${path} passes configured hosts to validation, not just the CSP`, async () => {
      const url = "https://images.unsplash.com/photo.png";
      expect((await post(path, url)).status).toBe(303);
      const write = path === "/featured" ? createFeatured : updateFeatured;
      expect(write).toHaveBeenCalled();
      expect(vi.mocked(write).mock.calls[0]!.at(-1)).toMatchObject({ imageUrl: url });
      expect((await post(path, url, { ...env, FEATURED_IMAGE_HOSTS: "" })).status).toBe(422);
    });
  }
});
