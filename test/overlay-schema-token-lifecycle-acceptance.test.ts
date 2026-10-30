// Test-Author-owned acceptance contract for overlay slice 1 (schema + token
// lifecycle store). The Builder changes production code, never these
// expectations. Spec: per-member OBS overlay page, build slice 1 (migration +
// pgTable + token store); decisions: free for every member (C1), one live
// token per member with 10s rotate grace and immediate revoke (C5).
//
// Pinned Builder contract — src/overlay-tokens.ts must export:
//   OVERLAY_TOKEN_PREFIX = "two_ov_"
//   OVERLAY_PREDECESSOR_GRACE_SECONDS = 10
//   OVERLAY_TELEMETRY_RETENTION_DAYS: positive integer (Builder picks the value)
//   newOverlayToken(): "two_ov_" + 32 random bytes, base64url (43 chars)
//   hashOverlayToken(token): SHA-256 hex (64 lowercase chars)
//   isValidOverlayToken(unknown): /^two_ov_[A-Za-z0-9_-]{43}$/
//   createMemoryOverlayTokenStore(clock?: () => number): OverlayTokenStore
//   createPostgresOverlayTokenStore(sql: OverlayTokenSql): OverlayTokenStore
//   OverlayTokenStore = {
//     mint(memberId, tokenHash): Promise<{ id }>            // rejects while live exists
//     rotate(memberId, oldHash, newHash): Promise<boolean>  // atomic; false unless old is live + owned
//     revoke(tokenHash): Promise<void>                      // immediate; kills grace both directions
//     revokeMemberTokens(memberId): Promise<number>         // all live + grace; returns count
//     lookupByHash(tokenHash): Promise<{ memberId, tokenId } | null> // live + 10s grace; bumps telemetry
//     listMemberTokens(memberId): Promise<OverlayTokenRow[]> // full history; prune-only deletion
//     pruneHistory(now: Date): Promise<number>              // non-live older than retention; spares grace
//   }
//   OverlayTokenRow = { id, memberId, tokenHash, status, createdAt, rotatedAt,
//     revokedAt, lastUsedAt, useCount } — timestamps are Date (null when unset),
//     useCount is a number (int8 must be converted), status is one of
//     "live" | "rotated" | "revoked" | "expired".
// Grace is measured from rotated_at (rotated rows resolve for exactly 10s).
// Telemetry age for pruneHistory is measured from created_at.
// Plus: a drizzle migration (next free number) creating overlay_configs and
// overlay_tokens per spec section 3, pgTable entries overlayConfigs and
// overlayTokens in src/db/overlay-schema.ts, and a migrations.lock entry. No routes
// yet: neither /o/* nor /overlay may exist after slice 1.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import rawApp from "../src/index";
import type { Env } from "../src/env";
import type { OverlayTokenSql } from "../src/overlay-tokens";
import { countMemberRows, eraseMember, type ErasureSql } from "../src/member-erasure";
import app from "./app";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { routeInventory } from "./helpers/route-inventory";

type OverlayModule = typeof import("../src/overlay-tokens");

async function overlayModule(): Promise<OverlayModule> {
  try {
    return await import("../src/overlay-tokens");
  } catch (error) {
    throw new Error(
      "RED: src/overlay-tokens.ts does not exist yet — the Builder implements it in slice 1.",
      { cause: error },
    );
  }
}

let snowflakeCounter = 0;
function snowflake(): string {
  snowflakeCounter += 1;
  return (100000000000000000n + BigInt(snowflakeCounter)).toString();
}

async function mintedPair(overlay: OverlayModule) {
  const plaintext = overlay.newOverlayToken();
  const tokenHash = await overlay.hashOverlayToken(plaintext);
  return { plaintext, tokenHash };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OVERLAY_TOKEN_RE = /^two_ov_[A-Za-z0-9_-]{43}$/;

describe("overlay token shape and hashing (hermetic)", () => {
  it("pins the token prefix and grace constants", async () => {
    const overlay = await overlayModule();
    expect(overlay.OVERLAY_TOKEN_PREFIX).toBe("two_ov_");
    expect(overlay.OVERLAY_PREDECESSOR_GRACE_SECONDS).toBe(10);
  });

  it("mints two_ov_ plus 32 random bytes as base64url", async () => {
    const overlay = await overlayModule();
    const token = overlay.newOverlayToken();
    expect(token).toMatch(OVERLAY_TOKEN_RE);
    expect(token).toHaveLength("two_ov_".length + 43);
  });

  it("mints unique tokens", async () => {
    const overlay = await overlayModule();
    const tokens = new Set<string>();
    for (let i = 0; i < 50; i += 1) tokens.add(overlay.newOverlayToken());
    expect(tokens.size).toBe(50);
  });

  it("hashes deterministically to lowercase SHA-256 hex", async () => {
    const overlay = await overlayModule();
    const { plaintext } = await mintedPair(overlay);
    const first = await overlay.hashOverlayToken(plaintext);
    const second = await overlay.hashOverlayToken(plaintext);
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes with SHA-256 (standard abc vector)", async () => {
    const overlay = await overlayModule();
    await expect(overlay.hashOverlayToken("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes distinct tokens distinctly", async () => {
    const overlay = await overlayModule();
    const hashes = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const { tokenHash } = await mintedPair(overlay);
      hashes.add(tokenHash);
    }
    expect(hashes.size).toBe(25);
  });

  it("validates the overlay shape and rejects session tokens and junk", async () => {
    const overlay = await overlayModule();
    expect(overlay.isValidOverlayToken(overlay.newOverlayToken())).toBe(true);
    expect(overlay.isValidOverlayToken("two_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      false,
    );
    expect(overlay.isValidOverlayToken("two_ov_short")).toBe(false);
    expect(overlay.isValidOverlayToken(`two_ov_${"A".repeat(42)}`)).toBe(false);
    expect(overlay.isValidOverlayToken(`two_ov_${"A".repeat(44)}`)).toBe(false);
    expect(overlay.isValidOverlayToken("")).toBe(false);
    expect(overlay.isValidOverlayToken(null)).toBe(false);
    expect(overlay.isValidOverlayToken(undefined)).toBe(false);
    expect(overlay.isValidOverlayToken(123)).toBe(false);
  });
});

describe("overlay token lifecycle, memory store (hermetic)", () => {
  const BASE = Date.parse("2026-10-21T12:00:00.000Z");

  function clocked() {
    let now = BASE;
    return {
      clock: () => now,
      advance: (ms: number) => {
        now += ms;
      },
      at: () => now,
    };
  }

  it("mints a live token that lookup resolves without leaking secrets", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const { plaintext, tokenHash } = await mintedPair(overlay);
    const minted = await store.mint(member, tokenHash);
    expect(minted.id).toMatch(UUID_RE);
    const found = await store.lookupByHash(tokenHash);
    expect(found).toMatchObject({ memberId: member });
    expect(found?.tokenId).toMatch(UUID_RE);
    expect(found?.tokenId).toBe(minted.id);
    const serialized = JSON.stringify(found);
    expect(serialized).not.toContain(plaintext);
    expect(serialized).not.toContain(tokenHash);
  });

  it("mints for any member with no entitlement gate (free for all members)", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    for (let i = 0; i < 3; i += 1) {
      const { tokenHash } = await mintedPair(overlay);
      const minted = await store.mint(snowflake(), tokenHash);
      expect(minted.id).toMatch(UUID_RE);
      expect(await store.lookupByHash(tokenHash)).not.toBeNull();
    }
  });

  it("rejects a second mint while one is live and keeps the original", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const first = await mintedPair(overlay);
    const second = await mintedPair(overlay);
    await store.mint(member, first.tokenHash);
    await expect(store.mint(member, second.tokenHash)).rejects.toThrow();
    expect(await store.lookupByHash(first.tokenHash)).toMatchObject({ memberId: member });
    expect(await store.lookupByHash(second.tokenHash)).toBeNull();
    const live = (await store.listMemberTokens(member)).filter((row) => row.status === "live");
    expect(live).toHaveLength(1);
  });

  it("mints again after revoke and keeps the revoked history row", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const first = await mintedPair(overlay);
    const second = await mintedPair(overlay);
    await store.mint(member, first.tokenHash);
    await store.revoke(first.tokenHash);
    const minted = await store.mint(member, second.tokenHash);
    expect(minted.id).toMatch(UUID_RE);
    expect(await store.lookupByHash(second.tokenHash)).toMatchObject({ memberId: member });
    const rows = await store.listMemberTokens(member);
    expect(rows.map((row) => row.status).sort()).toEqual(["live", "revoked"]);
  });

  it("stores hash only: history rows never carry plaintext", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const { plaintext, tokenHash } = await mintedPair(overlay);
    await store.mint(member, tokenHash);
    const rows = await store.listMemberTokens(member);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ memberId: member, tokenHash, status: "live" });
    expect(JSON.stringify(rows)).not.toContain(plaintext);
  });

  it("starts fresh tokens with zero telemetry", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const { tokenHash } = await mintedPair(overlay);
    await store.mint(member, tokenHash);
    const [row] = await store.listMemberTokens(member);
    expect(row?.useCount).toBe(0);
    expect(typeof row?.useCount).toBe("number");
    expect(row?.lastUsedAt).toBeNull();
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it("rotates atomically: old to rotated with a stamp, new to live", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    time.advance(60_000);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    const rows = await store.listMemberTokens(member);
    const byHash = new Map(rows.map((row) => [row.tokenHash, row]));
    expect(byHash.get(old.tokenHash)).toMatchObject({ status: "rotated" });
    expect(byHash.get(next.tokenHash)).toMatchObject({ status: "live" });
    expect(byHash.get(old.tokenHash)?.rotatedAt?.getTime()).toBe(time.at());
    expect(rows.filter((row) => row.status === "live")).toHaveLength(1);
  });

  it("honors the 10s predecessor grace, then the old token dies", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    time.advance(10_000 - 1);
    expect(await store.lookupByHash(old.tokenHash)).toMatchObject({ memberId: member });
    time.advance(1);
    expect(await store.lookupByHash(old.tokenHash)).toBeNull();
    expect(await store.lookupByHash(next.tokenHash)).toMatchObject({ memberId: member });
  });

  it("failed rotation returns false and creates nothing", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const { tokenHash } = await mintedPair(overlay);
    expect(await store.rotate(member, "0".repeat(64), tokenHash)).toBe(false);
    expect(await store.listMemberTokens(member)).toHaveLength(0);
    expect(await store.lookupByHash(tokenHash)).toBeNull();
  });

  it("second rotation of the same predecessor returns false", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    const third = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    expect(await store.rotate(member, old.tokenHash, third.tokenHash)).toBe(false);
    expect(await store.lookupByHash(third.tokenHash)).toBeNull();
  });

  it("rotation is owner-only: another member cannot rotate the token", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const alice = snowflake();
    const bob = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(alice, old.tokenHash);
    expect(await store.rotate(bob, old.tokenHash, next.tokenHash)).toBe(false);
    expect(await store.lookupByHash(old.tokenHash)).toMatchObject({ memberId: alice });
    expect(await store.listMemberTokens(bob)).toHaveLength(0);
  });

  it("revoke is immediate and stamps the row", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const member = snowflake();
    const { tokenHash } = await mintedPair(overlay);
    await store.mint(member, tokenHash);
    time.advance(5_000);
    await store.revoke(tokenHash);
    expect(await store.lookupByHash(tokenHash)).toBeNull();
    const [row] = await store.listMemberTokens(member);
    expect(row).toMatchObject({ status: "revoked" });
    expect(row?.revokedAt?.getTime()).toBe(time.at());
  });

  it("revoking the predecessor during grace kills it at once", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    await store.revoke(old.tokenHash);
    expect(await store.lookupByHash(old.tokenHash)).toBeNull();
    expect(await store.lookupByHash(next.tokenHash)).toMatchObject({ memberId: member });
  });

  it("revoking the successor kills the predecessor grace too", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    expect(await store.lookupByHash(old.tokenHash)).not.toBeNull();
    await store.revoke(next.tokenHash);
    expect(await store.lookupByHash(next.tokenHash)).toBeNull();
    expect(await store.lookupByHash(old.tokenHash)).toBeNull();
  });

  it("revoking an unknown hash is a no-op", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    await expect(store.revoke("f".repeat(64))).resolves.toBeUndefined();
  });

  it("revokeMemberTokens clears live plus grace and spares others", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const leaver = snowflake();
    const stayer = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    const other = await mintedPair(overlay);
    await store.mint(leaver, old.tokenHash);
    expect(await store.rotate(leaver, old.tokenHash, next.tokenHash)).toBe(true);
    await store.mint(stayer, other.tokenHash);
    expect(await store.revokeMemberTokens(leaver)).toBe(1);
    expect(await store.lookupByHash(old.tokenHash)).toBeNull();
    expect(await store.lookupByHash(next.tokenHash)).toBeNull();
    expect(await store.lookupByHash(other.tokenHash)).toMatchObject({ memberId: stayer });
    expect(await store.revokeMemberTokens(leaver)).toBe(0);
  });

  it("lookup of unknown, malformed, or plaintext input returns null", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const { plaintext } = await mintedPair(overlay);
    expect(await store.lookupByHash("0".repeat(64))).toBeNull();
    expect(await store.lookupByHash("not-a-hash")).toBeNull();
    expect(await store.lookupByHash("")).toBeNull();
    expect(await store.lookupByHash(plaintext)).toBeNull();
  });

  it("successful lookup bumps use telemetry on the resolved row only", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const member = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    time.advance(2_000);
    expect(await store.lookupByHash(next.tokenHash)).not.toBeNull();
    expect(await store.lookupByHash(next.tokenHash)).not.toBeNull();
    expect(await store.lookupByHash(old.tokenHash)).not.toBeNull();
    const rows = await store.listMemberTokens(member);
    const byHash = new Map(rows.map((row) => [row.tokenHash, row]));
    expect(byHash.get(next.tokenHash)).toMatchObject({ useCount: 2 });
    expect(byHash.get(next.tokenHash)?.lastUsedAt?.getTime()).toBe(time.at());
    expect(byHash.get(old.tokenHash)).toMatchObject({ useCount: 1 });
    expect(byHash.get(old.tokenHash)?.lastUsedAt?.getTime()).toBe(time.at());
  });

  it("failed lookup bumps no telemetry", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const { tokenHash } = await mintedPair(overlay);
    await store.mint(member, tokenHash);
    expect(await store.lookupByHash("0".repeat(64))).toBeNull();
    const [row] = await store.listMemberTokens(member);
    expect(row).toMatchObject({ useCount: 0, lastUsedAt: null });
  });

  it("lifecycle ops never delete history rows", async () => {
    const overlay = await overlayModule();
    const store = overlay.createMemoryOverlayTokenStore();
    const member = snowflake();
    const first = await mintedPair(overlay);
    const second = await mintedPair(overlay);
    await store.mint(member, first.tokenHash);
    expect(await store.rotate(member, first.tokenHash, second.tokenHash)).toBe(true);
    await store.revoke(second.tokenHash);
    const rows = await store.listMemberTokens(member);
    expect(rows.map((row) => row.status).sort()).toEqual(["revoked", "rotated"]);
  });

  it("retention export is a positive integer number of days", async () => {
    const overlay = await overlayModule();
    expect(Number.isInteger(overlay.OVERLAY_TELEMETRY_RETENTION_DAYS)).toBe(true);
    expect(overlay.OVERLAY_TELEMETRY_RETENTION_DAYS).toBeGreaterThan(0);
  });

  it("pruneHistory deletes aged non-live rows and spares live plus grace", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const retentionMs = overlay.OVERLAY_TELEMETRY_RETENTION_DAYS * 86_400_000;
    const member = snowflake();
    const ghost = snowflake();
    const old = await mintedPair(overlay);
    const live = await mintedPair(overlay);
    const gone = await mintedPair(overlay);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, live.tokenHash)).toBe(true);
    await store.mint(ghost, gone.tokenHash);
    await store.revoke(gone.tokenHash);
    time.advance(retentionMs + 86_400_000);
    const fresh = await mintedPair(overlay);
    expect(await store.rotate(member, live.tokenHash, fresh.tokenHash)).toBe(true);
    // old (rotated, aged) and gone (revoked, aged) prune; live-turned-rotated
    // stays because its grace window is still open; fresh live stays always.
    expect(await store.pruneHistory(new Date(time.at()))).toBe(2);
    const rows = await store.listMemberTokens(member);
    expect(rows.map((row) => row.status).sort()).toEqual(["live", "rotated"]);
    expect(await store.listMemberTokens(ghost)).toHaveLength(0);
    expect(await store.pruneHistory(new Date(time.at()))).toBe(0);
    time.advance(10_000);
    expect(await store.pruneHistory(new Date(time.at()))).toBe(1);
    expect(await store.listMemberTokens(member)).toHaveLength(1);
  });

  it("pruneHistory keeps telemetry on surviving rows", async () => {
    const overlay = await overlayModule();
    const time = clocked();
    const store = overlay.createMemoryOverlayTokenStore(time.clock);
    const retentionMs = overlay.OVERLAY_TELEMETRY_RETENTION_DAYS * 86_400_000;
    const member = snowflake();
    const { tokenHash } = await mintedPair(overlay);
    await store.mint(member, tokenHash);
    expect(await store.lookupByHash(tokenHash)).not.toBeNull();
    time.advance(retentionMs + 86_400_000);
    expect(await store.pruneHistory(new Date(time.at()))).toBe(0);
    const [row] = await store.listMemberTokens(member);
    expect(row).toMatchObject({ status: "live", useCount: 1 });
    expect(row?.lastUsedAt?.getTime()).toBe(BASE);
  });
});

describe("overlay pgTable entries (hermetic)", () => {
  it("src/db/overlay-schema.ts exports overlayTokens", async () => {
    const schema = (await import("../src/db/overlay-schema")) as Record<string, unknown>;
    expect(schema.overlayTokens, "Builder adds the overlayTokens pgTable").toBeDefined();
  });

  it("src/db/overlay-schema.ts exports overlayConfigs", async () => {
    const schema = (await import("../src/db/overlay-schema")) as Record<string, unknown>;
    expect(schema.overlayConfigs, "Builder adds the overlayConfigs pgTable").toBeDefined();
  });
});

describe("overlay migration files and lock (hermetic)", () => {
  const drizzleDir = fileURLToPath(new URL("../drizzle", import.meta.url).href);
  const overlayFiles = () =>
    readdirSync(drizzleDir).filter((name) => /^\d{4}_.*overlay.*\.sql$/.test(name));

  it("ships a drizzle migration for the overlay tables", () => {
    expect(overlayFiles().length).toBeGreaterThanOrEqual(1);
  });

  it("covers every overlay migration in the journal and lock with matching sha", () => {
    const files = overlayFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    const journal = JSON.parse(readFileSync(`${drizzleDir}/meta/_journal.json`, "utf8")) as {
      entries: { tag: string }[];
    };
    const lock = JSON.parse(readFileSync("migrations.lock", "utf8")) as {
      migrations: { path: string; sha256: string }[];
    };
    const tags = new Set(journal.entries.map((entry) => entry.tag));
    for (const file of files) {
      const tag = file.replace(/\.sql$/, "");
      expect(tags.has(tag), `journal covers ${file}`).toBe(true);
      const entry = lock.migrations.find((row) => row.path === `drizzle/${file}`);
      expect(entry, `migrations.lock covers drizzle/${file}`).toBeDefined();
      const bytes = readFileSync(`${drizzleDir}/${file}`);
      expect(entry?.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    }
  });

  it("creates both overlay tables in the overlay migration text", () => {
    const files = overlayFiles();
    expect(files.length).toBeGreaterThanOrEqual(1);
    const text = files.map((file) => readFileSync(`${drizzleDir}/${file}`, "utf8")).join("\n");
    expect(text).toContain("overlay_tokens");
    expect(text).toContain("overlay_configs");
    expect(text).toContain("token_hash");
  });
});

describe("no overlay routes yet (hermetic controls)", () => {
  it("registers neither /o/* nor /overlay routes", () => {
    const paths = routeInventory(rawApp).map((route) => route.path);
    expect(
      paths.filter(
        (path) =>
          path === "/o" || path.startsWith("/o/") || path === "/overlay" || path === "/overlay/",
      ),
    ).toEqual([]);
  });

  it("answers a synthetic overlay URL with a bare 404 and no session cookie", async () => {
    const env: Env = {
      APP_URL: "https://app.example.test",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token",
      DISCORD_GUILD_ID: "326474832151838730",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
    };
    const synthetic = `two_ov_${"A".repeat(43)}`;
    const response = await app.request(`/o/${synthetic}`, {}, env);
    expect(response.status).toBe(404);
    expect(response.headers.getSetCookie().join("\n")).not.toContain("__Host-two_session=");
    expect(await response.text()).not.toContain(synthetic);
  });
});

describe("overlay slice 1 on postgres (disposable DB)", () => {
  let fixture: JobsFixture;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error("DATABASE_URL is required for overlay PostgreSQL regressions");
    fixture = await createJobsFixture(process.env.DATABASE_URL, { max: 5 });
  });

  afterAll(async () => {
    await fixture?.dispose();
  });

  // Observe actual PostgreSQL lock waits rather than assuming a sleep made
  // either contender reach its statement snapshot.
  async function waitForBlocked(blockers: number[], excluded: number[] = []) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const rows = await fixture.client<{ pid: number; blockers: number[] }[]>`
        select pid, pg_blocking_pids(pid) as blockers from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'`;
      const waiter = rows.find(
        (row) => !excluded.includes(row.pid) && row.blockers.some((pid) => blockers.includes(pid)),
      );
      if (waiter) return waiter.pid;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("overlay contender did not reach the held lock");
  }

  it.each(["revoke", "erase"] as const)(
    "%s cannot miss a successor minted by an already in-flight rotation",
    async (operation) => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const old = await mintedPair(overlay);
      const next = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      let rotation: Promise<boolean> | undefined;
      let removal: Promise<unknown> | undefined;
      try {
        await fixture.client.begin(async (tx) => {
          const [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await tx`select id from overlay_tokens where token_hash = ${old.tokenHash} for update`;
          rotation = store.rotate(member, old.tokenHash, next.tokenHash);
          const rotationPid = await waitForBlocked([holder!.pid]);
          removal =
            operation === "revoke"
              ? store.revokeMemberTokens(member)
              : eraseMember(fixture.client as unknown as ErasureSql, member, { dryRun: false });
          await waitForBlocked([holder!.pid, rotationPid], [rotationPid]);
        });
        expect(await rotation).toBe(true);
        const removed = await removal;
        if (operation === "revoke") expect(removed).toBe(1);
        else {
          expect(removed).toMatchObject({ overlay_tokens: 2 });
          expect(await store.listMemberTokens(member)).toEqual([]);
        }
        expect(await store.lookupByHash(old.tokenHash)).toBeNull();
        expect(await store.lookupByHash(next.tokenHash)).toBeNull();
      } finally {
        await Promise.allSettled([rotation, removal]);
      }
    },
    15_000,
  );

  it.each(["revoke", "erase"] as const)(
    "%s waits for an uncommitted mint even when the member has no visible token",
    async (operation) => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const token = await mintedPair(overlay);
      // A fixture-only trigger parks the actual store mint after its INSERT
      // but before commit, without relying on the store's lock implementation.
      await fixture.client.unsafe(`create function pause_overlay_mint() returns trigger language plpgsql as $$
        begin perform pg_advisory_xact_lock(16101033); return new; end $$`);
      await fixture.client.unsafe(`create trigger pause_overlay_mint after insert on overlay_tokens
        for each row execute function pause_overlay_mint()`);
      let mint: Promise<{ id: string }> | undefined;
      let removal: Promise<unknown> | undefined;
      try {
        await fixture.client.begin(async (tx) => {
          const [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
          await tx`select pg_advisory_xact_lock(16101033)`;
          mint = store.mint(member, token.tokenHash);
          const mintPid = await waitForBlocked([holder!.pid]);
          removal =
            operation === "revoke"
              ? store.revokeMemberTokens(member)
              : eraseMember(fixture.client as unknown as ErasureSql, member, { dryRun: false });
          await waitForBlocked([mintPid]);
        });
        expect(await mint).toHaveProperty("id");
        const removed = await removal;
        if (operation === "revoke") expect(removed).toBe(1);
        else {
          expect(removed).toMatchObject({ overlay_tokens: 1 });
          expect(await store.listMemberTokens(member)).toEqual([]);
        }
        expect(await store.lookupByHash(token.tokenHash)).toBeNull();
      } finally {
        await Promise.allSettled([mint, removal]);
        await fixture.client.unsafe("drop trigger pause_overlay_mint on overlay_tokens");
        await fixture.client.unsafe("drop function pause_overlay_mint()");
      }
    },
    15_000,
  );

  it("member erasure counts and deletes overlay config and all token states, isolating others", async () => {
    const overlay = await overlayModule();
    const store = overlay.createPostgresOverlayTokenStore(
      fixture.client as unknown as OverlayTokenSql,
    );
    const sql = fixture.client as unknown as ErasureSql;
    const member = snowflake();
    const other = snowflake();
    const old = await mintedPair(overlay);
    const next = await mintedPair(overlay);
    const revoked = await mintedPair(overlay);
    const staying = await mintedPair(overlay);
    await store.mint(member, revoked.tokenHash);
    await store.revoke(revoked.tokenHash);
    await store.mint(member, old.tokenHash);
    expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
    await store.mint(other, staying.tokenHash);
    await fixture.client`insert into overlay_configs (member_id, elements)
      values (${member}, '{"line":"personal data"}'), (${other}, '{"line":"keep"}')`;
    const before = await countMemberRows(sql, member);
    expect(before).toMatchObject({ overlay_configs: 1, overlay_tokens: 3 });
    expect(await eraseMember(sql, member, { dryRun: true })).toMatchObject(before);
    expect(await store.lookupByHash(next.tokenHash)).not.toBeNull();
    expect(await eraseMember(sql, member, { dryRun: false })).toMatchObject(before);
    expect(await countMemberRows(sql, member)).toMatchObject({
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    expect(await store.listMemberTokens(member)).toEqual([]);
    expect(await store.lookupByHash(old.tokenHash)).toBeNull();
    expect(await store.lookupByHash(next.tokenHash)).toBeNull();
    expect(await eraseMember(sql, member, { dryRun: false })).toMatchObject({
      overlay_configs: 0,
      overlay_tokens: 0,
    });
    expect(await countMemberRows(sql, other)).toMatchObject({
      overlay_configs: 1,
      overlay_tokens: 1,
    });
    expect(await store.lookupByHash(staying.tokenHash)).toMatchObject({ memberId: other });
  });

  describe("token lifecycle store", () => {
    it("mints and resolves with hash-only persistence", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const { plaintext, tokenHash } = await mintedPair(overlay);
      const minted = await store.mint(member, tokenHash);
      expect(minted.id).toMatch(UUID_RE);
      expect(await store.lookupByHash(tokenHash)).toMatchObject({
        memberId: member,
        tokenId: minted.id,
      });
      const dump = (
        await fixture.client<{ t: string }[]>`SELECT t::text AS t FROM overlay_tokens AS t`
      )
        .map((row) => row.t)
        .join("\n");
      expect(dump).toContain(tokenHash);
      expect(dump).not.toContain(plaintext);
    });

    it("enforces one live token per member at the store", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const first = await mintedPair(overlay);
      const second = await mintedPair(overlay);
      await store.mint(member, first.tokenHash);
      await expect(store.mint(member, second.tokenHash)).rejects.toThrow();
      const live = (
        await fixture.client<{ n: number }[]>`SELECT count(*)::int AS n FROM overlay_tokens
          WHERE member_id = ${member} AND status = 'live'`
      )[0]?.n;
      expect(live).toBe(1);
    });

    it("owner-only rotation refuses foreign, unknown, and replayed predecessors without creating rows", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const attacker = snowflake();
      const old = await mintedPair(overlay);
      const next = await mintedPair(overlay);
      const refused = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      expect(await store.rotate(attacker, old.tokenHash, refused.tokenHash)).toBe(false);
      expect(await store.rotate(attacker, old.tokenHash, old.tokenHash)).toBe(false);
      expect(await store.rotate(member, refused.tokenHash, next.tokenHash)).toBe(false);
      expect(await store.listMemberTokens(member)).toMatchObject([
        { status: "live", tokenHash: old.tokenHash },
      ]);
      expect(await store.listMemberTokens(attacker)).toEqual([]);
      expect(await store.lookupByHash(refused.tokenHash)).toBeNull();
      expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
      expect(await store.rotate(member, old.tokenHash, refused.tokenHash)).toBe(false);
      expect(await store.lookupByHash(refused.tokenHash)).toBeNull();
      expect(await store.listMemberTokens(member)).toHaveLength(2);
    });

    it("pruneHistory spares an aged token rotated inside grace, then removes it after grace", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const old = await mintedPair(overlay);
      const next = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      const aged = new Date(
        Date.now() - (overlay.OVERLAY_TELEMETRY_RETENTION_DAYS + 5) * 86_400_000,
      );
      await fixture.client`update overlay_tokens set created_at = ${aged} where token_hash = ${old.tokenHash}`;
      expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
      expect(await store.pruneHistory(new Date())).toBe(0);
      expect(await store.listMemberTokens(member)).toHaveLength(2);
      const expired = new Date(Date.now() - 11_000);
      await fixture.client`update overlay_tokens set rotated_at = ${expired} where token_hash = ${old.tokenHash}`;
      expect(await store.pruneHistory(new Date())).toBe(1);
      expect(await store.listMemberTokens(member)).toMatchObject([{ status: "live" }]);
    });

    it("rotates with grace honored and revoke immediate", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const old = await mintedPair(overlay);
      const next = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
      expect(await store.lookupByHash(old.tokenHash)).toMatchObject({ memberId: member });
      expect(await store.lookupByHash(next.tokenHash)).toMatchObject({ memberId: member });
      await store.revoke(old.tokenHash);
      expect(await store.lookupByHash(old.tokenHash)).toBeNull();
      expect(await store.lookupByHash(next.tokenHash)).toMatchObject({ memberId: member });
    });

    it("measures grace from rotated_at: an 11s-old rotation no longer resolves", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const old = await mintedPair(overlay);
      const next = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      expect(await store.rotate(member, old.tokenHash, next.tokenHash)).toBe(true);
      await fixture.client`UPDATE overlay_tokens SET rotated_at = now() - make_interval(secs => 11)
        WHERE token_hash = ${old.tokenHash}`;
      expect(await store.lookupByHash(old.tokenHash)).toBeNull();
      expect(await store.lookupByHash(next.tokenHash)).toMatchObject({ memberId: member });
    });

    it("revokeMemberTokens clears the member and spares others", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const leaver = snowflake();
      const stayer = snowflake();
      const leaving = await mintedPair(overlay);
      const staying = await mintedPair(overlay);
      await store.mint(leaver, leaving.tokenHash);
      await store.mint(stayer, staying.tokenHash);
      expect(await store.revokeMemberTokens(leaver)).toBe(1);
      expect(await store.lookupByHash(leaving.tokenHash)).toBeNull();
      expect(await store.lookupByHash(staying.tokenHash)).toMatchObject({ memberId: stayer });
    });

    it("expired rows never resolve", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const { tokenHash } = await mintedPair(overlay);
      await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status)
        VALUES (${member}, ${tokenHash}, 'expired')`;
      expect(await store.lookupByHash(tokenHash)).toBeNull();
    });

    it("lookup bumps last_used_at and use_count on the resolved row", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const member = snowflake();
      const { tokenHash } = await mintedPair(overlay);
      await store.mint(member, tokenHash);
      const before = new Date();
      expect(await store.lookupByHash(tokenHash)).not.toBeNull();
      expect(await store.lookupByHash(tokenHash)).not.toBeNull();
      const [row] = await store.listMemberTokens(member);
      expect(row).toMatchObject({ useCount: 2 });
      expect(row?.lastUsedAt).toBeInstanceOf(Date);
      expect(row?.lastUsedAt?.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5_000);
    });

    it("pruneHistory deletes aged non-live rows and keeps live rows", async () => {
      const overlay = await overlayModule();
      const store = overlay.createPostgresOverlayTokenStore(
        fixture.client as unknown as OverlayTokenSql,
      );
      const retentionDays = overlay.OVERLAY_TELEMETRY_RETENTION_DAYS;
      const member = snowflake();
      const ghost = snowflake();
      const old = await mintedPair(overlay);
      const live = await mintedPair(overlay);
      const gone = await mintedPair(overlay);
      await store.mint(member, old.tokenHash);
      expect(await store.rotate(member, old.tokenHash, live.tokenHash)).toBe(true);
      await store.mint(ghost, gone.tokenHash);
      await store.revoke(gone.tokenHash);
      const aged = new Date(Date.now() - (retentionDays + 5) * 86_400_000);
      await fixture.client`UPDATE overlay_tokens
        SET created_at = ${aged}, rotated_at = ${aged} WHERE token_hash = ${old.tokenHash}`;
      await fixture.client`UPDATE overlay_tokens
        SET created_at = ${aged}, revoked_at = ${aged} WHERE token_hash = ${gone.tokenHash}`;
      expect(await store.pruneHistory(new Date())).toBe(2);
      expect((await store.listMemberTokens(member)).map((row) => row.status)).toEqual(["live"]);
      expect(await store.listMemberTokens(ghost)).toHaveLength(0);
      expect(await store.pruneHistory(new Date())).toBe(0);
    });
  });

  describe("schema", () => {
    it("overlay_tokens columns match the spec shape", async () => {
      const columns = await fixture.client<
        {
          column_name: string;
          data_type: string;
          is_nullable: string;
          column_default: string | null;
        }[]
      >`SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = ${fixture.schemaName} AND table_name = 'overlay_tokens'`;
      const byName = new Map(columns.map((column) => [column.column_name, column]));
      expect([...byName.keys()].sort()).toEqual(
        [
          "created_at",
          "id",
          "last_used_at",
          "member_id",
          "revoked_at",
          "rotated_at",
          "status",
          "token_hash",
          "use_count",
        ].sort(),
      );
      expect(byName.get("id")).toMatchObject({ data_type: "uuid", is_nullable: "NO" });
      expect(byName.get("id")?.column_default).toContain("gen_random_uuid");
      expect(byName.get("member_id")).toMatchObject({ data_type: "text", is_nullable: "NO" });
      expect(byName.get("token_hash")).toMatchObject({ data_type: "text", is_nullable: "NO" });
      expect(byName.get("status")).toMatchObject({ data_type: "text", is_nullable: "NO" });
      expect(byName.get("status")?.column_default).toContain("live");
      expect(byName.get("created_at")).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      });
      expect(byName.get("created_at")?.column_default).toContain("now()");
      expect(byName.get("rotated_at")).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      });
      expect(byName.get("revoked_at")).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      });
      expect(byName.get("last_used_at")).toMatchObject({
        data_type: "timestamp with time zone",
        is_nullable: "YES",
      });
      expect(byName.get("use_count")).toMatchObject({ data_type: "bigint", is_nullable: "NO" });
      expect(byName.get("use_count")?.column_default).toContain("0");
    });

    it("enforces token_hash uniqueness and the status check", async () => {
      const overlay = await overlayModule();
      const first = await mintedPair(overlay);
      await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash)
        VALUES (${snowflake()}, ${first.tokenHash})`;
      await expect(
        fixture.client`INSERT INTO overlay_tokens (member_id, token_hash)
          VALUES (${snowflake()}, ${first.tokenHash})`,
      ).rejects.toThrow();
      const fresh = await mintedPair(overlay);
      await expect(
        fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status)
          VALUES (${snowflake()}, ${fresh.tokenHash}, 'suspended')`,
      ).rejects.toThrow();
    });

    it("indexes overlay_tokens by member and status", async () => {
      const indexes = await fixture.client<
        { indexname: string; indexdef: string }[]
      >`SELECT indexname, indexdef FROM pg_indexes
        WHERE schemaname = ${fixture.schemaName} AND tablename = 'overlay_tokens'`;
      const memberIndex = indexes.find((index) => index.indexname === "overlay_tokens_member_idx");
      expect(memberIndex, "overlay_tokens_member_idx exists").toBeDefined();
      expect(memberIndex?.indexdef).toContain("member_id");
      expect(memberIndex?.indexdef).toContain("status");
      expect(
        indexes.some(
          (index) => index.indexdef.includes("UNIQUE") && index.indexdef.includes("token_hash"),
        ),
      ).toBe(true);
    });

    it("enforces the one-live partial unique index independently of store checks", async () => {
      const indexes = await fixture.client<{ indexdef: string }[]>`select indexdef from pg_indexes
        where schemaname = ${fixture.schemaName} and indexname = 'overlay_tokens_member_live_unique'`;
      expect(indexes).toHaveLength(1);
      expect(indexes[0]?.indexdef).toMatch(/UNIQUE.*\(member_id\).*WHERE.*status.*'live'/);
      const overlay = await overlayModule();
      const member = snowflake();
      const first = await mintedPair(overlay);
      const second = await mintedPair(overlay);
      await fixture.client`insert into overlay_tokens (member_id, token_hash) values (${member}, ${first.tokenHash})`;
      await expect(
        fixture.client`insert into overlay_tokens (member_id, token_hash) values (${member}, ${second.tokenHash})`,
      ).rejects.toMatchObject({ code: "23505" });
      await fixture.client`insert into overlay_tokens (member_id, token_hash, status) values (${member}, ${second.tokenHash}, 'revoked')`;
    });

    it("overlay_configs carries member config with jsonb defaults and no user FK", async () => {
      const columns = await fixture.client<
        { column_name: string; data_type: string; column_default: string | null }[]
      >`SELECT column_name, data_type, column_default FROM information_schema.columns
        WHERE table_schema = ${fixture.schemaName} AND table_name = 'overlay_configs'`;
      const byName = new Map(columns.map((column) => [column.column_name, column]));
      expect([...byName.keys()].sort()).toEqual(
        ["elements", "member_id", "theme", "updated_at"].sort(),
      );
      expect(byName.get("member_id")).toMatchObject({ data_type: "text" });
      expect(byName.get("elements")).toMatchObject({ data_type: "jsonb" });
      expect(byName.get("elements")?.column_default).toContain("'{}'");
      expect(byName.get("theme")).toMatchObject({ data_type: "jsonb" });
      expect(byName.get("theme")?.column_default).toContain("'{}'");
      expect(byName.get("updated_at")).toMatchObject({ data_type: "timestamp with time zone" });
      const tableRef = `"${fixture.schemaName}".overlay_configs`;
      const constraints = await fixture.client<
        { conname: string; contype: string }[]
      >`SELECT conname, contype FROM pg_constraint WHERE conrelid = to_regclass(${tableRef})`;
      expect(constraints.some((constraint) => constraint.contype === "f")).toBe(false);
      expect(constraints.some((constraint) => constraint.contype === "p")).toBe(true);
    });

    it("overlay_configs defaults apply on a bare insert", async () => {
      const member = snowflake();
      await fixture.client`INSERT INTO overlay_configs (member_id) VALUES (${member})`;
      const [row] = await fixture.client<
        { elements: unknown; theme: unknown; updated_at: Date }[]
      >`SELECT elements, theme, updated_at FROM overlay_configs WHERE member_id = ${member}`;
      expect(row?.elements).toEqual({});
      expect(row?.theme).toEqual({});
      expect(row?.updated_at).toBeInstanceOf(Date);
      await expect(
        fixture.client`INSERT INTO overlay_configs (member_id) VALUES (${member})`,
      ).rejects.toThrow();
    });
  });
});
