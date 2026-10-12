// B1 WebMCP pilot flag: DB-free. The pilot script tag is injected by
// middleware only when WEBMCP_PILOT_ENABLED is exactly "true"/"1" and only
// on the four pilot pages (/ events list, /e/:key detail, /join, /). The
// middleware reads no session and no cookie, so moderator sessions render
// byte-identical markup with no extra tools.
import { describe, expect, it } from "vitest";
import app from "./app";
import { isWebmcpPilotPath, webmcpPilotEnabled, WEBMCP_PILOT_SCRIPT } from "../src/webmcp-pilot";
import type { Env } from "../src/env";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const onEnv: Env = { ...baseEnv, WEBMCP_PILOT_ENABLED: "true" };

describe("webmcp pilot flag", () => {
  it.each(["true", "1"])("flag %s enables the pilot", (flag) => {
    expect(webmcpPilotEnabled({ WEBMCP_PILOT_ENABLED: flag })).toBe(true);
  });

  it.each([undefined, "", "false", "0", "yes", "TRUE"])("flag %s stays off", (flag) => {
    expect(webmcpPilotEnabled({ WEBMCP_PILOT_ENABLED: flag })).toBe(false);
  });

  it.each(["/", "/events", "/events/past", "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV", "/join"])(
    "pilot page %s carries the island",
    (path) => {
      expect(isWebmcpPilotPath(path)).toBe(true);
    },
  );

  it.each([
    "/about",
    "/faq",
    "/rules",
    "/privacy",
    "/login",
    "/auth/discord",
    "/admin",
    "/api/public/events",
    "/api/public/join",
    "/openapi.json",
    "/events.json",
  ])("non-pilot path %s carries no island", (path) => {
    expect(isWebmcpPilotPath(path)).toBe(false);
  });

  it("script tag is the deferred island with no inline code", () => {
    expect(WEBMCP_PILOT_SCRIPT).toBe('<script src="/islands/model-context.js" defer></script>');
  });

  it("flag off leaves the join page byte-identical with or without a session cookie", async () => {
    const anon = await app.request("/join", {}, baseEnv);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).not.toContain("/islands/model-context.js");
    const mod = await app.request(
      "/join",
      { headers: { cookie: "two_session=sess_moderator_probe" } },
      baseEnv,
    );
    expect(mod.status).toBe(200);
    expect(await mod.text()).toBe(anonHtml);
  });

  it("flag on injects the island before </body> on the join page, identically for cookie bearers", async () => {
    const anon = await app.request("/join", {}, onEnv);
    expect(anon.status).toBe(200);
    const anonHtml = await anon.text();
    expect(anonHtml).toContain(`${WEBMCP_PILOT_SCRIPT}</body>`);
    const mod = await app.request(
      "/join",
      { headers: { cookie: "two_session=sess_moderator_probe" } },
      onEnv,
    );
    expect(mod.status).toBe(200);
    expect(await mod.text()).toBe(anonHtml);
  });

  it("flag on leaves non-pilot pages untouched", async () => {
    const res = await app.request("/about", {}, onEnv);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("/islands/model-context.js");
  });
});
