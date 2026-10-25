import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

const id = "100000000000000001";
const secret = "test-session-secret-at-least-32-bytes-long";
const env = { APP_URL: "https://next.example.test", SESSION_SECRET: secret } as Env;
const seeded = {
  id,
  username: "alice",
  avatar: null,
  bio: "Hi",
  games: ["Chess"],
  timezone: "UTC",
};

async function setup() {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: id,
    username: "alice",
    avatar: null,
    member: true,
    moderator: false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const cookie = (
    await serializeSigned("__Host-two_session", token, secret, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
  const store = createMemoryProfileStore([{ ...seeded }]);
  const save = vi.spyOn(store, "save");
  const app = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async () => true,
    throttle: async () => ({ limited: false }),
  });
  const send = (body: BodyInit, type: string, accept: string, method = "PATCH") =>
    app.request(
      `/members/${id}`,
      { method, headers: { cookie, origin: env.APP_URL, "content-type": type, accept }, body },
      env,
    );
  const json = (obj: unknown, accept = "application/json") =>
    send(JSON.stringify(obj), "application/json", accept);
  return { store, save, send, json };
}
const textarea = (html: string) =>
  /<textarea[^>]*name="games_text"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];

describe("profile games JSON/form round-trip", () => {
  it("rejects JSON that omits both games representations, without saving", async () => {
    const { store, save, json } = await setup();
    const res = await json({ bio: "Updated", timezone: "UTC" });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { fields: Record<string, string> }).fields.games).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(id)?.games).toEqual(["Chess"]);
  });

  it("still clears on explicit [] and saves array / games_text", async () => {
    const { store, json } = await setup();
    expect((await json({ bio: "a", timezone: "UTC", games: [] })).status).toBe(200);
    expect(store.rows.get(id)?.games).toEqual([]);
    expect((await json({ bio: "a", timezone: "UTC", games: [" Go ", "Go", "Chess"] })).status).toBe(
      200,
    );
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
    const res2 = await send(
      "_method=PATCH&bio=x&timezone=UTC",
      "application/x-www-form-urlencoded",
      "text/html",
      "POST",
    );
    expect(res2.status).toBe(303);
    expect(store.rows.get(id)?.games).toEqual([]);
  });

  it("retains JSON games as escaped editable text on HTML 422 and after resubmit", async () => {
    const { store, json, send } = await setup();
    const res = await json(
      { bio: "a", timezone: "Mars/Base", games: ["Chess", "Go", "<b>x</b>"] },
      "text/html",
    );
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(textarea(html)).toBe("Chess\nGo\n&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    const fixed = await send(
      new URLSearchParams({ bio: "a", timezone: "UTC", games_text: "Chess\nGo" }).toString(),
      "application/x-www-form-urlencoded",
      "text/html",
    );
    expect(fixed.status).toBe(303);
    expect(store.rows.get(id)?.games).toEqual(["Chess", "Go"]);
  });

  it("prefers games_text and ignores malformed array elements when re-rendering", async () => {
    const { json } = await setup();
    const both = await json(
      { bio: "a", timezone: "Mars/Base", games: ["A"], games_text: "B" },
      "text/html",
    );
    expect(textarea(await both.text())).toBe("B");
    const bad = await json(
      { bio: "a", timezone: "Mars/Base", games: ["A", { toString: "<i>x</i>" }, 5, null] },
      "text/html",
    );
    expect(bad.status).toBe(422);
    const html = await bad.text();
    expect(textarea(html)).toBe("A");
    expect(html).not.toContain("<i>x</i>");
  });

  it("saves case-insensitive JSON with parameters exactly like application/json", async () => {
    const { store, save, send } = await setup();
    const res = await send(
      JSON.stringify({ bio: "a", timezone: "UTC", games: ["Chess"] }),
      "Application/JSON; charset=UTF-8",
      "application/json",
    );
    expect(res.status).toBe(200);
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.rows.get(id)?.games).toEqual(["Chess"]);
  });

  it("treats Application/JSON as JSON: missing games is 422, never a form wipe", async () => {
    const { store, save, send } = await setup();
    const res = await send(
      JSON.stringify({ bio: "Updated", timezone: "UTC" }),
      "Application/JSON",
      "application/json",
    );
    expect(res.status).toBe(422);
    expect(save).not.toHaveBeenCalled();
    expect(store.rows.get(id)).toMatchObject({ bio: "Hi", games: ["Chess"], timezone: "UTC" });
  });

  it("refuses unsupported media types with 415 without saving or wiping", async () => {
    for (const type of ["text/plain", "application/merge-patch+json"]) {
      const { store, save, send } = await setup();
      const res = await send(
        JSON.stringify({ bio: "Updated", timezone: "UTC", games: ["Chess"] }),
        type,
        "application/json",
      );
      expect(res.status, type).toBe(415);
      expect(res.headers.get("cache-control"), type).toBe("private, no-store");
      expect(save, type).not.toHaveBeenCalled();
      expect(store.rows.get(id), type).toMatchObject({
        bio: "Hi",
        games: ["Chess"],
        timezone: "UTC",
      });
    }
  });

  it("refuses a missing Content-Type with 415 without saving or wiping", async () => {
    // A string body would get `content-type: text/plain;charset=UTF-8` from the
    // Fetch spec, so exercise a genuinely missing header instead: no body, and
    // a Blob body (whose empty type sets no header).
    const payload = JSON.stringify({ bio: "Updated", timezone: "UTC", games: ["Chess"] });
    const bodies: Array<{ label: string; body: BodyInit | undefined }> = [
      { label: "no body", body: undefined },
      { label: "Blob body", body: new Blob([payload]) },
    ];
    for (const { label, body } of bodies) {
      const sessions = createMemorySessionStore();
      const token = newSessionToken();
      await sessions.create({
        tokenHash: await hashToken(token),
        userId: id,
        username: "alice",
        avatar: null,
        member: true,
        moderator: false,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      const cookie = (
        await serializeSigned("__Host-two_session", token, secret, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      const store = createMemoryProfileStore([{ ...seeded }]);
      const save = vi.spyOn(store, "save");
      const app = profilesApp({
        sessionStore: sessions,
        store,
        accessLog: async () => true,
        throttle: async () => ({ limited: false }),
      });
      const res = await app.request(
        `/members/${id}`,
        {
          method: "PATCH",
          headers: { cookie, origin: env.APP_URL, accept: "application/json" },
          body,
        },
        env,
      );
      expect(res.status, label).toBe(415);
      expect(res.headers.get("cache-control"), label).toBe("private, no-store");
      expect(save, label).not.toHaveBeenCalled();
      expect(store.rows.get(id), label).toMatchObject({
        bio: "Hi",
        games: ["Chess"],
        timezone: "UTC",
      });
    }
  });
});

describe("profile save Accept media-range selection", () => {
  // The JSON contract below is the existing lowercase-`application/json`
  // behavior. Mixed-case spellings of the same media range must select it
  // identically; names that merely contain the text `application/json`
  // must not. Wildcard and q-value preference policy are intentionally not
  // pinned here: this only exercises exact media-range matching.
  const valid = { bio: "Updated", timezone: "UTC", games: ["Go", "Chess"] };
  const invalid = { bio: "a", timezone: "Mars/Base", games: ["<b>x</b>"] };
  const jsonAck = { saved: true, message: "Profile saved." };
  const jsonError = {
    error: "invalid",
    fields: { timezone: "Choose a valid IANA timezone, e.g. Europe/London." },
  };

  const jsonAccepts = [
    "Application/JSON",
    "APPLICATION/JSON; charset=UTF-8",
    "application/JSON; Charset=UTF-8",
    "text/html, Application/Json",
    "Text/HTML , Application/JSON ; charset=UTF-8",
  ];

  it.each(jsonAccepts)(
    "valid JSON save with Accept %s returns the JSON acknowledgement, not a redirect",
    async (accept) => {
      const { store, save, json } = await setup();
      const res = await json(valid, accept);
      expect(res.status, accept).toBe(200);
      expect(res.headers.get("content-type"), accept).toContain("application/json");
      expect(await res.json(), accept).toEqual(jsonAck);
      expect(save, accept).toHaveBeenCalledTimes(1);
      expect(store.rows.get(id), accept).toMatchObject({ bio: "Updated", games: ["Go", "Chess"] });
    },
  );

  it.each(jsonAccepts)(
    "invalid JSON save with Accept %s returns the JSON 422 errors, not an HTML re-render",
    async (accept) => {
      const { store, save, json } = await setup();
      const res = await json(invalid, accept);
      expect(res.status, accept).toBe(422);
      expect(res.headers.get("content-type"), accept).toContain("application/json");
      expect(await res.json(), accept).toEqual(jsonError);
      expect(save, accept).not.toHaveBeenCalled();
      expect(store.rows.get(id), accept).toMatchObject({ bio: "Hi", games: ["Chess"] });
    },
  );

  it("form-encoded saves follow the same mixed-case JSON selection", async () => {
    const ok = await setup();
    const okRes = await ok.send(
      "bio=Updated&timezone=UTC&games_text=Go",
      "application/x-www-form-urlencoded",
      "Application/JSON",
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual(jsonAck);
    expect(ok.store.rows.get(id)?.games).toEqual(["Go"]);

    const bad = await setup();
    const badRes = await bad.send(
      new URLSearchParams({ bio: "a", timezone: "Mars/Base", games_text: "<b>x</b>" }).toString(),
      "application/x-www-form-urlencoded",
      "APPLICATION/JSON",
    );
    expect(badRes.status).toBe(422);
    expect(badRes.headers.get("content-type")).toContain("application/json");
    expect(await badRes.json()).toEqual(jsonError);
    expect(bad.save).not.toHaveBeenCalled();
  });

  const lookalikeAccepts = [
    "application/jsonx",
    "application/json-patch",
    "x-application/json",
    'text/html; note="application/json"',
    "text/html, application/jsonx",
    "APPLICATION/JSONX",
  ];

  it.each(lookalikeAccepts)(
    "valid save with lookalike Accept %s stays on the HTML 303 path",
    async (accept) => {
      const { store, save, json } = await setup();
      const res = await json(valid, accept);
      expect(res.status, accept).toBe(303);
      expect(res.headers.get("location"), accept).toBe(`/members/${id}`);
      expect(save, accept).toHaveBeenCalledTimes(1);
      expect(store.rows.get(id)?.games, accept).toEqual(["Go", "Chess"]);
    },
  );

  it.each(lookalikeAccepts)(
    "invalid save with lookalike Accept %s stays on the escaped HTML 422 path",
    async (accept) => {
      const { save, json } = await setup();
      const res = await json(invalid, accept);
      expect(res.status, accept).toBe(422);
      expect(res.headers.get("content-type"), accept).toContain("text/html");
      const html = await res.text();
      expect(textarea(html), accept).toBe("&lt;b&gt;x&lt;/b&gt;");
      expect(html, accept).not.toContain("<b>x</b>");
      expect(save, accept).not.toHaveBeenCalled();
    },
  );

  it("native HTML controls keep 303 success and escaped editable HTML 422", async () => {
    const ok = await setup();
    const okRes = await ok.json(valid, "text/html");
    expect(okRes.status).toBe(303);
    expect(okRes.headers.get("location")).toBe(`/members/${id}`);
    expect(ok.save).toHaveBeenCalledTimes(1);
    expect(ok.store.rows.get(id)?.games).toEqual(["Go", "Chess"]);

    const bad = await setup();
    const badRes = await bad.json(invalid, "text/html");
    expect(badRes.status).toBe(422);
    expect(badRes.headers.get("content-type")).toContain("text/html");
    const html = await badRes.text();
    expect(textarea(html)).toBe("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(bad.save).not.toHaveBeenCalled();
  });
});
