import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { events } from "../src/db/admin-schema";
import * as suggestions from "../src/events/suggestions";
import { NOT_FOUND_SUGGESTIONS_TTL_MS } from "../src/not-found-suggestions";
import app from "./app";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// DB-backed: unknown/invalid /e/:key misses render the same
// cached guest snapshot as ordinary 404s through the real member-read
// boundary (postgres-js statements + read classification), with one
// suggestion fill per TTL. Needs DATABASE_URL (agent-testdb); skipped without
// it. The hermetic sibling (event-detail-not-found-cache.test.ts) covers the
// same sharing with proxy doubles.
const APP_URL = "https://next.example.test";
const UNKNOWN_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const T0 = Date.parse("2026-10-02T12:00:00Z");

const suggested = (html: string) =>
  [...html.matchAll(/href="\/e\/([^"]+)" data-testid="error-event-suggestion"/g)].map((m) => m[1]);

describe.skipIf(!process.env.DATABASE_URL)("event-detail miss suggestions (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let env: EnvWithAdminDb;
  let clock = 0;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    env = {
      APP_URL,
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      ADMIN_DB: fixture.db,
    } as unknown as EnvWithAdminDb;
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  beforeEach(async () => {
    await fixture.reset();
    // Same DB source every test, so jump past the TTL for a cold snapshot.
    clock += 1;
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(T0 + clock * (NOT_FOUND_SUGGESTIONS_TTL_MS + 1_000));
    await fixture.db.insert(events).values({
      eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
      title: "Game night",
      game: "Chess",
      description: "Bring a friend.",
      purpose: null,
      startsAt: new Date("2099-01-01T18:00:00Z"),
      endsAt: new Date("2099-01-01T20:00:00Z"),
      timezone: "UTC",
      location: "Discord lobby",
      capacity: 10,
      status: "published",
      rsvpOpen: true,
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function eventMiss(path: string) {
    const res = await app.request(path, {}, env);
    const html = await res.text();
    expect(res.status, path).toBe(404);
    expect(res.headers.get("x-robots-tag"), path).toBe("noindex, nofollow");
    expect(res.headers.get("set-cookie"), path).toBeNull();
    expect(html, path).toContain("We cannot find that page");
    return html;
  }

  it("renders rows on cold unknown-key misses from a single fill", async () => {
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    const first = await eventMiss(`/e/${UNKNOWN_KEY}`);
    expect(suggested(first)).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    vi.setSystemTime(T0 + clock * (NOT_FOUND_SUGGESTIONS_TTL_MS + 1_000) + 5_000);
    const second = await eventMiss(`/e/${UNKNOWN_KEY}`);
    expect(suggested(second)).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    expect(fills).toHaveBeenCalledOnce();
  });

  it("serves invalid-key misses from the same snapshot without a fresh read", async () => {
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    expect(suggested(await eventMiss("/e/nope"))).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    vi.setSystemTime(T0 + clock * (NOT_FOUND_SUGGESTIONS_TTL_MS + 1_000) + 5_000);
    expect(suggested(await eventMiss("/e/also-invalid"))).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    expect(fills).toHaveBeenCalledOnce();
  });

  it("shares one snapshot between an ordinary 404 and an event-detail miss", async () => {
    const fills = vi.spyOn(suggestions, "notFoundSuggestions");
    const plain = await app.request("/lost/link", {}, env);
    expect(plain.status).toBe(404);
    expect(suggested(await plain.text())).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    expect(fills).toHaveBeenCalledOnce();
    vi.setSystemTime(T0 + clock * (NOT_FOUND_SUGGESTIONS_TTL_MS + 1_000) + 5_000);
    expect(suggested(await eventMiss(`/e/${UNKNOWN_KEY}`))).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAW"]);
    expect(fills).toHaveBeenCalledOnce();
  });
});
