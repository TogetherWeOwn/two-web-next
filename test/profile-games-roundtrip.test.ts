import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const id = "100000000000000001";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;
const seeded = { id, username: "alice", avatar: null, bio: "Hi", games: ["Chess"], timezone: "UTC" };

async function setup() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({ tokenHash: await hashToken(token), userId: id, username: "alice", avatar: null, member: true, moderator: false, expiresAt: new Date(Date.now() + 3600_000) });
  const cookie = (await serializeSigned("__Host-two_session", token, secret, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
  const store = createMemoryProfileStore([{ ...seeded }]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({ sessionStore: sessions, store, accessLog: async () => true, throttle: async () => ({ limited: false }) });
  const send = (body: BodyInit, type: string, accept: string, method = "PATCH") =>
    app.request(`/members/${id}`, { method, headers: { cookie, origin: env.APP_URL, "content-type": type, accept }, body }, env);
  const json = (obj: unknown, accept = "application/json") => send(JSON.stringify(obj), "application/json", accept);
  return { store, save, send, json };
}
const textarea = (html: string) => /<textarea[^>]*name="games_text"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];

describe("profile games JSON/form round-trip", () => {
  it("rejects JSON that omits both games representations, without saving", async () => {
    const { store, save, json } = await setup();
    const res = await json({ bio: "Updated", timezone: "UTC" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { errors: Record<string, string> }).errors.games).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(id)?.games).toEqual(["Chess"]);
  });

  it("still clears on explicit [] and saves array / games_text", async () => {
    const { store, json } = await setup();
    expect((await json({ bio: "a", timezone: "UTC", games: [] })).status).toBe(200);
    expect(store.rows.get(id)?.games).toEqual([]);
    expect((await json({ bio: "a", timezone: "UTC", games: [" Go ", "Go", "Chess"] })).status).toBe(200);
    expect(store.rows.get(id)?.games).toEqual(["Go", "Chess"]);
    expect((await json({ bio: "a", timezone: "UTC", games_text: "Halo\nGo" })).status).toBe(200);
    expect(store.rows.get(id)?.games).toEqual(["Halo", "Go"]);
  });

  it("keeps the plain form blank-list behavior and method override", async () => {
    const { store, send } = await setup();
    const res = await send("bio=x&timezone=UTC", "application/x-www-form-urlencoded", "text/html");
    expect(res.status).toBe(303);
    expect(store.rows.get(id)?.games).toEqual([]);
    store.rows.get(id)!.games = ["Chess"];
    const res2 = await send("_method=PATCH&bio=x&timezone=UTC", "application/x-www-form-urlencoded", "text/html", "POST");
    expect(res2.status).toBe(303);
    expect(store.rows.get(id)?.games).toEqual([]);
  });

  it("retains JSON games as escaped editable text on HTML 422 and after resubmit", async () => {
    const { store, json, send } = await setup();
    const res = await json({ bio: "a", timezone: "Mars/Base", games: ["Chess", "Go", "<b>x</b>"] }, "text/html");
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(textarea(html)).toBe("Chess\nGo\n&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    const fixed = await send(new URLSearchParams({ bio: "a", timezone: "UTC", games_text: "Chess\nGo" }).toString(), "application/x-www-form-urlencoded", "text/html");
    expect(fixed.status).toBe(303);
    expect(store.rows.get(id)?.games).toEqual(["Chess", "Go"]);
  });

  it("prefers games_text and ignores malformed array elements when re-rendering", async () => {
    const { json } = await setup();
    const both = await json({ bio: "a", timezone: "Mars/Base", games: ["A"], games_text: "B" }, "text/html");
    expect(textarea(await both.text())).toBe("B");
    const bad = await json({ bio: "a", timezone: "Mars/Base", games: ["A", { toString: "<i>x</i>" }, 5, null] }, "text/html");
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(textarea(html)).toBe("A");
    expect(html).not.toContain("<i>x</i>");
  });
});
