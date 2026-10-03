import { describe, expect, it } from "vitest";
import { createMemorySessionStore } from "../src/sessions";

const source = () => ({
  tokenHash: "same-token-source",
  userId: "original-user",
  username: "Original user",
  avatar: null,
  member: false,
  moderator: false,
  createdAt: new Date(1000),
  expiresAt: new Date(3000),
});

const claims = {
  userId: "original-user",
  username: "Original user",
  avatar: null,
  member: false,
  moderator: false,
};

describe("memory same-token rotation contract", () => {
  it("accepts an active same-token proposal without changing identity or claims", async () => {
    const store = createMemorySessionStore(() => 2000);
    const original = source();
    await store.create(original);
    const proposal = {
      ...original,
      userId: "proposed-user",
      username: "Proposed moderator",
      avatar: "proposed-avatar",
      member: true,
      moderator: true,
      createdAt: new Date(2000),
      expiresAt: new Date(9000),
    };
    expect(await store.rotate(original.tokenHash, proposal)).toBe(true);
    expect(await store.get(original.tokenHash)).toEqual(claims);
  });

  it.each([2500, 9000])(
    "keeps the original expiry when proposed expiry is %s",
    async (proposedExpiry) => {
      let now = 2000;
      const store = createMemorySessionStore(() => now);
      const original = source();
      await store.create(original);
      const proposal = {
        ...original,
        createdAt: new Date(now),
        expiresAt: new Date(proposedExpiry),
      };
      expect(await store.rotate(original.tokenHash, proposal)).toBe(true);
      now = original.expiresAt.getTime() - 1;
      expect(await store.get(original.tokenHash)).toEqual(claims);
      now = original.expiresAt.getTime();
      expect(
        await store.rotate(original.tokenHash, {
          ...original,
          expiresAt: new Date(9000),
        }),
      ).toBe(false);
      expect(await store.get(original.tokenHash)).toBeNull();
    },
  );

  it("leaves the stored row eligible for sweeping at its original expiry", async () => {
    const store = createMemorySessionStore(() => 2000);
    const original = source();
    await store.create(original);
    const proposal = {
      ...original,
      createdAt: new Date(2000),
      expiresAt: new Date(9000),
    };
    expect(await store.rotate(original.tokenHash, proposal)).toBe(true);
    expect(await store.sweepExpired(new Date(2999))).toBe(0);
    expect(await store.sweepExpired(original.expiresAt)).toBe(1);
    expect(await store.sweepExpired(original.expiresAt)).toBe(0);
    expect(await store.get(original.tokenHash)).toBeNull();
  });

  // createdAt is not exposed by SessionStore.get; a no-op must not copy even
  // extra proposed metadata into the memory row via object spread.
  it.each(["createdAt", "expiresAt"])(
    "does not read proposed %s during an active no-op",
    async (field) => {
      const store = createMemorySessionStore(() => 2000);
      const original = source();
      await store.create(original);
      const proposal = { ...original };
      Object.defineProperty(proposal, field, {
        enumerable: true,
        get() {
          throw new Error(`same-token proposal read ${field}`);
        },
      });
      await expect(store.rotate(original.tokenHash, proposal)).resolves.toBe(true);
      expect(await store.get(original.tokenHash)).toEqual(claims);
      expect(await store.sweepExpired(original.expiresAt)).toBe(1);
    },
  );
});
