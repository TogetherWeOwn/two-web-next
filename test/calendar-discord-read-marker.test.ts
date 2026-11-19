import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { discordEventsSource } from "../src/events/discord-transients";
import { registerEventRoutes } from "../src/events/routes";
import { loadEventsPage } from "../src/kit-events";
import { renderEventsHtml as renderKitFallback } from "../src/kit-events-html";
import {
  GAME_ORIGIN,
  gameRecoveryFixture,
  renderKitEvents,
} from "./helpers/calendar-game-recovery";

const generation = 1_800_000_000_000;
const cases = [
  { name: "persisted healthy", epoch: generation, failed: false, marker: 3_600_000_000_000 },
  { name: "known failure", epoch: generation, failed: true, marker: 3_600_000_000_001 },
  { name: "known cold failure", epoch: 0, failed: true, marker: 1 },
  { name: "unknown failure", epoch: null, failed: true, marker: -1 },
  { name: "inconclusive healthy", epoch: undefined, failed: false, marker: 0 },
];

describe("calendar SSR Discord read marker", () => {
  it.each(cases)(
    "emits the $name marker on all calendar roots",
    async ({ epoch, failed, marker }) => {
      const { db } = gameRecoveryFixture();
      const discord = {
        upcoming: async () => [],
        lastReadFailed: () => failed,
        ...(epoch !== undefined ? { lastReadSnapshotAt: () => epoch } : {}),
      };
      const env = {
        APP_URL: GAME_ORIGIN,
        DISCORD_INVITE_URL: "https://discord.gg/example",
        ADMIN_DB: db,
        DISCORD_EVENTS: discord,
      } as unknown as Env;
      const url = new URL("/events?view=calendar&month=2099-05", GAME_ORIGIN);
      const headers = { "x-two-island": "events-calendar" };

      const app = new Hono<{ Bindings: Env }>();
      registerEventRoutes(
        app,
        async () => null,
        async () => null,
      );
      const hono = await app.request(url.href, { headers }, env);
      expect(hono.status).toBe(200);

      const data = await loadEventsPage({
        env,
        url,
        method: "GET",
        island: true,
        request: new Request(url, { headers }),
        setHeaders: () => {},
        deleteJoinCookie: () => {},
        dbForFn: async () => db,
        sessionForFn: async () => null,
        journeyForFn: async () => null,
        discordForFn: discordEventsSource,
      });
      const fallback = await renderKitFallback(data, {});
      const kit = await renderKitEvents(data, {}, false, true);

      for (const body of [await hono.text(), fallback.body, kit.body]) {
        const root = /<section\b[^>]*data-island="events-calendar"[^>]*>/.exec(body)?.[0];
        expect(root).toContain(`data-discord-read="${marker}"`);
      }
    },
  );
});
