import { serializeSigned } from "hono/utils/cookie";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import app from "./app";
import { createFeatured, getFeatured, updateFeatured } from "../src/admin/store";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

vi.mock("../src/admin/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/admin/store")>(),
  createFeatured: vi.fn(),
  getFeatured: vi.fn(),
  updateFeatured: vi.fn(),
  recordAccess: vi.fn().mockResolvedValue(true),
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
  id: 1, legacyId: null, title: "Featured", body: null, url: null, imageUrl: null, imageAlt: null,
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

describe("featured preview response image policy (local fixtures)", () => {
  it.each([
    ["https://cdn.discordapp.com/photo.jpg", "https://cdn.discordapp.com"],
    ["https://images.unsplash.com/photo.jpg", "https://images.unsplash.com"],
    ["https://unapproved.com/photo.jpg", null],
  ])("only emits a CSP-permitted saved image for %s", async (imageUrl, allowedOrigin) => {
    vi.mocked(getFeatured).mockResolvedValue({ ...existing, isPublished: true, imageUrl, imageAlt: "Players together" });
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({
      tokenHash: await hashToken(token), userId: "111", username: "mod", avatar: null,
      member: true, moderator: true, expiresAt: new Date(Date.now() + 3600_000),
    });
    const cookie = (await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
    const bindings = { ...env, SESSION_STORE: store };
    for (const [path, init] of [
      ["/admin/featured/1", { headers: { cookie } }],
      ["/admin/featured/1", {
        method: "POST", headers: { cookie, origin: env.APP_URL },
        body: new URLSearchParams({ title: "", image_url: "https://unapproved.com/bad.jpg" }),
      }],
    ] as const) {
      const res = await app.request(path, init, bindings);
      expect(res.status).toBe("method" in init ? 422 : 200);
      const html = await res.text();
      const csp = res.headers.get("content-security-policy")!;
      expect(csp).not.toContain("unsafe-inline");
      if (allowedOrigin) {
        expect(html).toContain(`src="${imageUrl}"`);
        const imgSrc = csp.split(";").find((directive) => directive.trim().startsWith("img-src "))!;
        expect(imgSrc.split(/\s+/)).toContain(allowedOrigin);
      } else expect(html).not.toContain("<img");
    }
  });
});

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

    it.each(["localdomain", "localhost.localdomain", "cdn.localhost.localdomain", "alt", "images.alt", "cdn.images.alt", "corp", "images.corp", "cdn.images.corp", "mail", "images.mail", "cdn.images.mail"])(`${path} rejects configured reserved namespace %s without writing`, async (host) => {
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
