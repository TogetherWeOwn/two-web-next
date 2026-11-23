import { describe, expect, it } from "vitest";
import {
  DISCORD_WIDGET_SNAPSHOT_MAX_AGE_MS,
  DISCORD_WIDGET_VERDICT_TTL_MS,
  createDiscordWidgetHealth,
} from "../src/discord-widget";

const GUILD = "999999999999999991";
const TTL = DISCORD_WIDGET_VERDICT_TTL_MS;

function widgetPayload() {
  return {
    id: GUILD,
    name: "Together We Own",
    instant_invite: "https://discord.gg/widget-invite",
    presence_count: 42,
    channels: [{ id: "1", name: "stage-night", position: 1 }],
    members: [],
  };
}

async function agedSnapshot(ageMs: number, ttlMs?: number) {
  let clock = 0;
  const widget = createDiscordWidgetHealth({
    fetch: (async () => Response.json(widgetPayload())) as typeof globalThis.fetch,
    now: () => clock,
    ...(ttlMs === undefined ? {} : { ttlMs }),
  });
  const pending: Promise<unknown>[] = [];
  widget.url(GUILD, (probe) => pending.push(probe));
  await Promise.all(pending);
  expect(widget.snapshot(GUILD)).not.toBeNull();
  clock += ageMs;
  return widget.snapshot(GUILD);
}

describe("snapshot() servable bound (default TTL)", () => {
  it("pins the documented 3x bound as an exported-constant ratio", () => {
    expect(DISCORD_WIDGET_SNAPSHOT_MAX_AGE_MS).toBe(3 * DISCORD_WIDGET_VERDICT_TTL_MS);
  });

  it("age TTL-1 is fresh: served with stale false", async () => {
    const snapshot = await agedSnapshot(TTL - 1);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.stale).toBe(false);
  });

  it("age TTL is stale-but-served: served with stale true", async () => {
    const snapshot = await agedSnapshot(TTL);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.stale).toBe(true);
  });

  it("age 3xTTL-1 is still served qualified", async () => {
    const snapshot = await agedSnapshot(3 * TTL - 1);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.stale).toBe(true);
  });

  it("age 3xTTL drops to null", async () => {
    await expect(agedSnapshot(3 * TTL)).resolves.toBeNull();
  });
});

describe("snapshot() servable bound scales with an injected ttlMs", () => {
  it("a 1 s TTL serves at 2999 ms and drops at 3000 ms", async () => {
    const served = await agedSnapshot(2999, 1000);
    expect(served).not.toBeNull();
    expect(served?.stale).toBe(true);
    await expect(agedSnapshot(3000, 1000)).resolves.toBeNull();
  });
});
