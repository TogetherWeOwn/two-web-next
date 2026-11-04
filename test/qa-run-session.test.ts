import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { QA_IDENTITIES } from "../src/qa";
import { QA_RUN_ORIGIN, type QaRunDescriptor } from "../src/qa-run-auth";
import { createQaRunSessionBoundary } from "../src/qa-run-session";
import { createMemorySessionStore, hashToken } from "../src/sessions";

const ISSUED = Date.UTC(2026, 10, 4, 8) / 1000;
const E = ISSUED + 1470;
const descriptor: QaRunDescriptor = [
  "two.qa.run.v1",
  "123456",
  "TogetherWeOwn/two-web-next",
  "2035",
  "a".repeat(40),
  "b".repeat(40),
  "c".repeat(40),
  "456789",
  "1",
  "staging",
  QA_RUN_ORIGIN,
  "candidate-qa-login",
];
const q = createHash("sha256").update(JSON.stringify(descriptor)).digest("hex");
const binding = JSON.stringify({
  schema: "two.qa.verifier.v1",
  descriptor,
  q,
  credentialSha256: "f".repeat(64),
  issuedAt: ISSUED,
  notBefore: ISSUED,
  expiresAt: ISSUED + 1500,
});
const request = { binding, requestUrl: `${QA_RUN_ORIGIN}/profile`, appUrl: QA_RUN_ORIGIN };

function fixture() {
  let now = ISSUED;
  // Deliberately stale store clock: rows stay live after the auth deadline.
  // Proves refusal does not depend on DB expiry, browser expiry or row GC.
  const store = createMemorySessionStore(() => ISSUED * 1000);
  const boundary = createQaRunSessionBoundary(store, { ...request, clock: () => now });
  return {
    store,
    boundary,
    advance: (seconds: number) => {
      now = ISSUED + seconds;
    },
  };
}

describe("key-free qualification session boundary (memory fixtures only)", () => {
  it.each(["qa-member", "qa-moderator"])(
    "issues only %s with fixed privilege and capped expiry",
    async (name) => {
      const { store, boundary } = fixture();
      const create = vi.spyOn(store, "create");
      const issued = (await boundary.issue(name))!;
      const identity = QA_IDENTITIES[name]!;
      expect(issued.token).toMatch(new RegExp(`^q1s\\.${q}\\.[A-Za-z0-9_-]{43}$`));
      expect(issued.cookieTtlSeconds).toBe(1470);
      expect(issued.expiresAt).toEqual(new Date(E * 1000));
      expect(create).toHaveBeenCalledWith({
        userId: identity.discordId,
        username: identity.username,
        avatar: null,
        member: true,
        moderator: identity.moderator,
        tokenHash: await hashToken(issued.token),
        statusHash: `q1p.${q}.${await hashToken(issued.token)}`,
        expiresAt: new Date(E * 1000),
      });
      expect(JSON.stringify(create.mock.calls)).not.toContain(issued.token);
      expect(await boundary.read(issued.token)).toEqual(issued.row);
    },
  );

  it("refuses unknown/prototype identity names without touching the store", async () => {
    const { store, boundary } = fixture();
    const create = vi.spyOn(store, "create");
    for (const name of ["toString", "__proto__", "admin", "qa-member ", ""]) {
      expect(await boundary.issue(name)).toBeNull();
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps original E through renewal, rotation, grace and status", async () => {
    const { store, boundary, advance } = fixture();
    const issued = (await boundary.issue("qa-moderator"))!;
    const beforeStatus = await boundary.status(issued.token);
    advance(60); // early cancellation/lost cleanup permits the residual window
    const rotated = (await boundary.rotate(issued.token))!;
    expect(rotated.token).not.toBe(issued.token);
    expect(rotated.expiresAt).toEqual(issued.expiresAt);
    expect(rotated.cookieTtlSeconds).toBe(1410);
    expect(await boundary.read(issued.token)).toEqual(issued.row); // predecessor grace
    expect(await boundary.renew(rotated.token)).toBe(true);
    expect(await boundary.status(rotated.token)).toBe(beforeStatus);
    expect(await boundary.isActive(beforeStatus!)).toBe(true);
    advance(1469);
    expect(await boundary.read(issued.token)).toEqual(issued.row);
    expect((await boundary.rotate(rotated.token))!.cookieTtlSeconds).toBe(1);
    const get = vi.spyOn(store, "get");
    const renew = vi.spyOn(store, "renew");
    const rotate = vi.spyOn(store, "rotate");
    const statusHash = vi.spyOn(store, "statusHash");
    const isActive = vi.spyOn(store, "isActive");
    for (const seconds of [1470, 1500, 7200]) {
      advance(seconds);
      expect(await boundary.read(issued.token)).toBeNull();
      expect(await boundary.read(rotated.token)).toBeNull();
      expect(await boundary.renew(rotated.token)).toBe(false);
      expect(await boundary.rotate(rotated.token)).toBeNull();
      expect(await boundary.status(rotated.token)).toBeNull();
      expect(await boundary.isActive(beforeStatus!)).toBe(false);
      expect(await boundary.issue("qa-member")).toBeNull();
      expect(await boundary.revoke(rotated.token)).toBe(false);
    }
    for (const spy of [get, renew, rotate, statusHash, isActive])
      expect(spy).not.toHaveBeenCalled();
    expect(await store.isActive(beforeStatus!)).toBe(true); // row unchanged
  });

  it("rejects copied production config, restored B and a new Q before store lookup", async () => {
    const { store, boundary } = fixture();
    const issued = (await boundary.issue("qa-member"))!;
    const status = (await boundary.status(issued.token))!;
    const changedDescriptor = [...descriptor];
    changedDescriptor[8] = "2";
    const newQ = createHash("sha256").update(JSON.stringify(changedDescriptor)).digest("hex");
    const alteredBinding = JSON.stringify({
      ...JSON.parse(binding),
      descriptor: changedDescriptor,
      q: newQ,
    });
    const get = vi.spyOn(store, "get");
    const isActive = vi.spyOn(store, "isActive");
    const create = vi.spyOn(store, "create");
    for (const override of [
      { requestUrl: "https://togetherweown.com/profile" },
      { binding: undefined }, // restored ordinary staging, no verifier
      { binding: "{" },
      { binding: alteredBinding },
    ]) {
      const other = createQaRunSessionBoundary(store, {
        ...request,
        ...override,
        clock: () => ISSUED,
      });
      expect(await other.read(issued.token)).toBeNull();
      expect(await other.rotate(issued.token)).toBeNull();
      expect(await other.renew(issued.token)).toBe(false);
      expect(await other.status(issued.token)).toBeNull();
      expect(await other.isActive(status)).toBe(false);
      expect(await other.revoke(issued.token, true)).toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
    expect(isActive).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(await store.get(await hashToken(issued.token))).toEqual(issued.row);
  });

  it("refuses ordinary, malformed and cross-purpose cookie tokens before DB access", async () => {
    const { store, boundary } = fixture();
    const get = vi.spyOn(store, "get");
    for (const token of [
      "two_" + "a".repeat(43),
      `q1s.${q}.bad`,
      `qa1.${q}.${"a".repeat(43)}`,
      "",
    ]) {
      expect(await boundary.read(token)).toBeNull();
      expect(await boundary.rotate(token)).toBeNull();
      expect(await boundary.renew(token)).toBe(false);
      expect(await boundary.status(token)).toBeNull();
      expect(await boundary.revoke(token)).toBe(false);
    }
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses nonfixture identity or incorrect privilege even with a valid stored hash", async () => {
    const { store, boundary } = fixture();
    const issued = (await boundary.issue("qa-member"))!;
    for (const change of [
      { userId: "123456" },
      { moderator: true },
      { member: false },
      { username: "not QA" },
      { avatar: "unexpected" },
    ]) {
      await store.create({
        ...issued.row,
        ...change,
        tokenHash: await hashToken(issued.token),
        expiresAt: issued.expiresAt,
      });
      expect(await boundary.read(issued.token)).toBeNull();
      expect(await boundary.rotate(issued.token)).toBeNull();
      expect(await boundary.renew(issued.token)).toBe(false);
      expect(await boundary.status(issued.token)).toBeNull();
      expect(await boundary.revoke(issued.token)).toBe(false);
    }
  });

  it("rechecks the deadline after an asynchronous store read or write", async () => {
    const { store, boundary, advance } = fixture();
    const issued = (await boundary.issue("qa-member"))!;
    const original = store.get;
    vi.spyOn(store, "get").mockImplementation(async (hash) => {
      const row = await original(hash);
      advance(1470);
      return row;
    });
    expect(await boundary.read(issued.token)).toBeNull();
    advance(0);
    expect(await boundary.rotate(issued.token)).toBeNull();
    advance(0);
    expect(await boundary.renew(issued.token)).toBe(false);
    advance(0);
    expect(await boundary.status(issued.token)).toBeNull();
    advance(0);
    const originalCreate = store.create;
    vi.spyOn(store, "create").mockImplementation(async (row) => {
      await originalCreate(row);
      advance(1470);
    });
    expect(await boundary.issue("qa-member")).toBeNull();
  });

  it("fresh login replaces and revokes old sessions; logout kills lineage and grace", async () => {
    const { store, boundary } = fixture();
    const first = (await boundary.issue("qa-member"))!;
    const replacement = (await boundary.issue("qa-member", first.token))!;
    expect(await boundary.read(first.token)).toBeNull();
    const rotated = (await boundary.rotate(replacement.token))!;
    const status = (await boundary.status(rotated.token))!;
    expect(await boundary.read(replacement.token)).not.toBeNull();
    expect(await boundary.revoke(rotated.token)).toBe(true);
    expect(await boundary.read(replacement.token)).toBeNull();
    expect(await boundary.read(rotated.token)).toBeNull();
    expect(await boundary.isActive(status)).toBe(false);
    expect(await store.get(await hashToken(first.token))).toBeNull();
  });

  it("logout from a grace predecessor revokes its successor and status", async () => {
    const { boundary } = fixture();
    const first = (await boundary.issue("qa-member"))!;
    const rotated = (await boundary.rotate(first.token))!;
    const status = (await boundary.status(rotated.token))!;
    expect(await boundary.read(first.token)).not.toBeNull();
    expect(await boundary.revoke(first.token)).toBe(true);
    expect(await boundary.read(first.token)).toBeNull();
    expect(await boundary.read(rotated.token)).toBeNull();
    expect(await boundary.isActive(status)).toBe(false);
  });

  it("does not let an old or ordinary status suffix be relabeled under a new Q", async () => {
    const { boundary, store } = fixture();
    const old = (await boundary.issue("qa-member"))!;
    const status = (await boundary.status(old.token))!;
    const changedDescriptor = [...descriptor];
    changedDescriptor[8] = "2";
    const newQ = createHash("sha256").update(JSON.stringify(changedDescriptor)).digest("hex");
    const next = createQaRunSessionBoundary(store, {
      ...request,
      binding: JSON.stringify({ ...JSON.parse(binding), descriptor: changedDescriptor, q: newQ }),
      clock: () => ISSUED,
    });
    expect(await next.isActive(status.replace(q, newQ))).toBe(false);
    const ordinaryHash = "a".repeat(64);
    await store.create({ ...old.row, tokenHash: ordinaryHash, expiresAt: old.expiresAt });
    expect(await store.isActive(ordinaryHash)).toBe(true);
    expect(await boundary.isActive(`q1p.${q}.${ordinaryHash}`)).toBe(false);
    expect(await store.isActive(status)).toBe(true);
    expect(await boundary.isActive(status)).toBe(true);
  });

  it("sign-out everywhere revokes the fixture user but not the other identity", async () => {
    const { boundary } = fixture();
    const member = (await boundary.issue("qa-member"))!;
    const moderator = (await boundary.issue("qa-moderator"))!;
    expect(await boundary.revoke(member.token, true)).toBe(true);
    expect(await boundary.read(member.token)).toBeNull();
    expect(await boundary.read(moderator.token)).not.toBeNull();
  });
});
