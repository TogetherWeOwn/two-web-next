import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { storeForEnv } from "../src/http/session";
import { createMemorySessionStore } from "../src/sessions";

describe("session store selection", () => {
  it("uses the injected request store when present", async () => {
    const store = createMemorySessionStore();
    const env = { SESSION_STORE: store } as unknown as Env;
    expect(await storeForEnv(env)).toBe(store);
  });

  it("allocates an isolated empty store when the database is not configured", async () => {
    const env = {} as Env;
    const store = await storeForEnv(env);
    expect(await storeForEnv(env)).not.toBe(store);
    await expect(store.get("fixture-hash")).resolves.toBeNull();
  });
});
