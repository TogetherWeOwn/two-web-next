// Revoke kills predecessor grace permanently: rotate(A→B), revoke(B),
// mint(C) inside the 10s window must leave A dead. A re-mint starts a new
// chain; it must not revive a killed URL. Both stores, same contract.
// (The Test-Author acceptance suite owns the slice-1 contract; this file
// pins the revoke-grace interaction only.)
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createMemoryOverlayTokenStore,
  createPostgresOverlayTokenStore,
  hashOverlayToken,
  newOverlayToken,
  type OverlayTokenStore,
} from "../src/overlay-tokens";
import type { Sql } from "../src/sessions";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

async function freshHash(): Promise<string> {
  return hashOverlayToken(newOverlayToken());
}

describe("overlay revoke kills predecessor grace (memory store)", () => {
  it("revoke, re-mint inside the window, old hash stays dead", async () => {
    let now = 1_786_000_000_000;
    const store = createMemoryOverlayTokenStore(() => now);
    const member = "revoke-grace-memory";
    const oldHash = await freshHash();
    const nextHash = await freshHash();
    const remintHash = await freshHash();
    await store.mint(member, oldHash);
    expect(await store.rotate(member, oldHash, nextHash)).toBe(true);
    expect(await store.lookupByHash(oldHash)).toMatchObject({ memberId: member });
    now += 4_000;
    await store.revoke(nextHash);
    expect(await store.lookupByHash(oldHash)).toBeNull();
    now += 1_000;
    await store.mint(member, remintHash);
    expect(await store.lookupByHash(remintHash)).toMatchObject({ memberId: member });
    // Still inside the 10s window (t0+5s): the killed URL stays dead.
    expect(await store.lookupByHash(oldHash)).toBeNull();
  });

  it("revokeMemberTokens kills grace past a re-mint", async () => {
    let now = 1_786_000_100_000;
    const store = createMemoryOverlayTokenStore(() => now);
    const member = "revoke-grace-member-memory";
    const oldHash = await freshHash();
    const nextHash = await freshHash();
    const remintHash = await freshHash();
    await store.mint(member, oldHash);
    expect(await store.rotate(member, oldHash, nextHash)).toBe(true);
    now += 2_000;
    expect(await store.revokeMemberTokens(member)).toBe(1);
    now += 1_000;
    await store.mint(member, remintHash);
    expect(await store.lookupByHash(oldHash)).toBeNull();
    expect(await store.lookupByHash(remintHash)).toMatchObject({ memberId: member });
  });

  it("grace still resolves when nothing was revoked (control)", async () => {
    let now = 1_786_000_200_000;
    const store = createMemoryOverlayTokenStore(() => now);
    const member = "revoke-grace-control";
    const oldHash = await freshHash();
    const nextHash = await freshHash();
    await store.mint(member, oldHash);
    expect(await store.rotate(member, oldHash, nextHash)).toBe(true);
    now += 9_999;
    expect(await store.lookupByHash(oldHash)).toMatchObject({ memberId: member });
    now += 1;
    expect(await store.lookupByHash(oldHash)).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("overlay revoke kills grace on postgres", () => {
  let fixture: JobsFixture;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL as string);
  });

  afterAll(async () => {
    await fixture.dispose();
  });

  async function expectRevokeKillsGrace(store: OverlayTokenStore, member: string) {
    const oldHash = await freshHash();
    const nextHash = await freshHash();
    const remintHash = await freshHash();
    const t0 = Date.now();
    await store.mint(member, oldHash);
    expect(await store.rotate(member, oldHash, nextHash)).toBe(true);
    // Grace is alive before the revoke (sequence runs in ms, window is 10s).
    expect(await store.lookupByHash(oldHash)).toMatchObject({ memberId: member });
    await store.revoke(nextHash);
    expect(await store.lookupByHash(oldHash)).toBeNull();
    await store.mint(member, remintHash);
    expect(await store.lookupByHash(remintHash)).toMatchObject({ memberId: member });
    // Prove the final lookup lands inside the 10s grace window, so a stalled
    // runner fails here instead of passing vacuously on an expired window.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await store.lookupByHash(oldHash)).toBeNull();
  }

  it("revoke, re-mint, old hash stays dead", async () => {
    const store = createPostgresOverlayTokenStore(fixture.client as unknown as Sql);
    await expectRevokeKillsGrace(store, `pg-revoke-grace-${Date.now()}`);
  });

  it("revokeMemberTokens, re-mint, old hash stays dead", async () => {
    const store = createPostgresOverlayTokenStore(fixture.client as unknown as Sql);
    const member = `pg-revoke-grace-member-${Date.now()}`;
    const oldHash = await freshHash();
    const nextHash = await freshHash();
    const remintHash = await freshHash();
    const t0 = Date.now();
    await store.mint(member, oldHash);
    expect(await store.rotate(member, oldHash, nextHash)).toBe(true);
    expect(await store.revokeMemberTokens(member)).toBe(1);
    await store.mint(member, remintHash);
    // Same in-window proof as the helper: a stalled runner must fail here,
    // not pass vacuously on an expired grace window.
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await store.lookupByHash(oldHash)).toBeNull();
    expect(await store.lookupByHash(remintHash)).toMatchObject({ memberId: member });
  });
});
