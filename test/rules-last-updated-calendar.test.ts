// route-inventory: GET /rules
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import app from "./app";
import type { Env } from "../src/env";
import { rulesLastUpdated } from "../src/rules-last-updated";
import { rulesLastUpdated as exportedRulesLastUpdated } from "../src/index";

vi.mock("postgres", () => ({
  default: vi.fn(() => { throw new Error("rules must not connect to a database"); }),
}));

const warning = "Invalid community.rules_last_updated — hiding /rules stamp";
const impossibleDates = [
  "2026-02-30", "2026-02-31", "2026-04-31", "2026-06-31",
  "2026-09-31", "2026-11-31", "2026-02-29", "1900-02-29", "2100-02-29",
  "0100-02-29",
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rules last-updated calendar validation", () => {
  it("retains the entry-point export contract", () => {
    expect(exportedRulesLastUpdated).toBe(rulesLastUpdated);
  });

  it.each(impossibleDates)("hides impossible date %s with the existing warning", (raw) => {
    expect(rulesLastUpdated(raw)).toBeNull();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it.each([
    ["2026-01-31", "31 January 2026"],
    ["2026-02-28", "28 February 2026"],
    ["2026-03-31", "31 March 2026"],
    ["2026-04-30", "30 April 2026"],
    ["2026-05-31", "31 May 2026"],
    ["2026-06-30", "30 June 2026"],
    ["2026-07-31", "31 July 2026"],
    ["2026-08-31", "31 August 2026"],
    ["2026-09-30", "30 September 2026"],
    ["2026-10-31", "31 October 2026"],
    ["2026-11-30", "30 November 2026"],
    ["2026-12-31", "31 December 2026"],
    ["2024-02-29", "29 February 2024"],
    ["2000-02-29", "29 February 2000"],
    ["2400-02-29", "29 February 2400"],
    ["0004-02-29", "29 February 0004"],
    ["0400-02-29", "29 February 0400"],
    ["0099-01-01", "1 January 0099"],
    ["0000-01-01", "1 January 0000"],
  ])("preserves the exact ISO and label for %s", (iso, label) => {
    expect(rulesLastUpdated(iso)).toEqual({ iso, label });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("trims surrounding whitespace without changing formatting", () => {
    expect(rulesLastUpdated(" \t2026-09-01\n ")).toEqual({
      iso: "2026-09-01", label: "1 September 2026",
    });
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " \t\n "])("silently hides an empty value (%j)", (raw) => {
    expect(rulesLastUpdated(raw)).toBeNull();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([
    "someday", "2026-00-01", "2026-13-01", "2026-01-00", "2026-01-32",
    "2026-9-01", "2026-09-1", "026-09-01", "02026-09-01",
    "2026-09-01T00:00:00Z", "2026/09/01", "-2026-09-01",
  ])("retains malformed-value fallback for %s", (raw) => {
    expect(rulesLastUpdated(raw)).toBeNull();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
  });
});

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

describe("DB-free rules route calendar stamp", () => {
  it.each(impossibleDates)("returns 200 without a stamp or dependencies for %s", async (raw) => {
    const fetch = vi.fn(() => { throw new Error("rules must not fetch dependencies"); });
    vi.stubGlobal("fetch", fetch);
    const SESSION_STORE = new Proxy({}, {
      get: () => { throw new Error("rules must not read sessions"); },
    });
    const res = await app.request("/rules", {
      headers: { cookie: "__Host-two_session=forged" },
    }, { ...env, SESSION_STORE, RULES_LAST_UPDATED: raw });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const html = await res.text();
    expect(html).not.toContain("rules-last-updated");
    expect(html).toContain('data-testid="rules-list"');
    expect(html).toContain('data-testid="rules-join"');
    expect(postgres).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(warning);
  });

  it("renders a valid leap-day stamp with the unchanged machine and human dates", async () => {
    const res = await app.request("/rules", {}, { ...env, RULES_LAST_UPDATED: " 2000-02-29 " });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    expect(await res.text()).toContain('<time datetime="2000-02-29">29 February 2000</time>');
    expect(postgres).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });
});
