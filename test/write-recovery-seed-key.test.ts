import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { STAGING_APP_URL } from "../src/qa";
import { expiredWriteBounce } from "../src/write-recovery";

// Demo seed keys are allowed event keys on staging/local bindings but have no
// canonical ULID form, so they exercise the uncanonicalized-key fallback in
// the shared expired-write destination (production treats them as unkeyed).
const SEED = "seed-calendar-01";
const env = {
  APP_URL: STAGING_APP_URL,
  SESSION_SECRET: "local-fixture-secret-at-least-32-bytes-long",
};

const app = new Hono();
app.all("*", (c) => expiredWriteBounce(c, true));

async function destination(path: string, method: string) {
  const res = await app.request(new URL(path, STAGING_APP_URL), { method }, env);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string; recovery: string };
  expect(body.error).toBe("unauthenticated");
  return new URL(body.recovery, STAGING_APP_URL).searchParams.get("next");
}

describe("expired seed-key write recovery destinations (local fixtures)", () => {
  it.each([
    ["PUT", `/events/${SEED}/rsvp`],
    ["PATCH", `/events/${SEED}`],
  ])("refererless %s %s returns to the seed event page", async (method, path) => {
    expect(await destination(path, method)).toBe(`/e/${SEED}`);
  });
});
