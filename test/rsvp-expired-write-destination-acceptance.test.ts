import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { expiredWriteBounce } from "../src/write-recovery";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const env = {
  APP_URL,
  SESSION_SECRET: "local-fixture-secret-at-least-32-bytes-long",
};

// Exercise the shared response boundary rather than a second destination parser.
// Losing the event key must fail even when the route correctly returns a 401.
const app = new Hono();
app.all("*", (c) => expiredWriteBounce(c, true));

async function destination(path: string, method: string, referer?: string) {
  const res = await app.request(
    new URL(path, APP_URL),
    { method, headers: referer ? { referer } : {} },
    env,
  );
  expect(res.status).toBe(401);
  expect(res.headers.get("location")).toBeNull();
  const body = (await res.json()) as { error: string; recovery: string };
  expect(body.error).toBe("Unauthorized");
  const recovery = new URL(body.recovery, APP_URL);
  expect(recovery.origin).toBe(APP_URL);
  expect(recovery.pathname).toBe("/auth/recover");
  return recovery.searchParams.get("next");
}

describe("expired event-write recovery destinations (local fixtures)", () => {
  it.each([
    ["PUT", `/events/${KEY}/rsvp`],
    ["DELETE", `/events/${KEY}/rsvp`],
    ["PATCH", `/events/${KEY}`],
    ["POST", `/events/${KEY}/publish`],
  ])(
    "refererless %s %s returns to the event, not the listing or write URL",
    async (method, path) => {
      expect(await destination(path, method)).toBe(`/e/${KEY}`);
    },
  );

  it.each([
    ["POST", "/events"],
    ["POST", "/events/rsvp"],
    ["PUT", "/events/not-an-event-key/rsvp"],
  ])("unkeyed or invalid-key %s %s keeps the listing fallback", async (method, path) => {
    expect(await destination(path, method)).toBe("/events");
  });

  it("preserves the same-origin event page and attendee query supplied by the browser", async () => {
    expect(await destination(`/events/${KEY}/rsvp`, "PUT", `${APP_URL}/e/${KEY}?attendees=2`)).toBe(
      `/e/${KEY}?attendees=2`,
    );
  });

  it.each([
    "https://hostile.example/e/other?attendees=9",
    `${APP_URL}//hostile.example/e/other`,
    "not a URL",
  ])("unsafe referer %s cannot displace the keyed fallback", async (referer) => {
    expect(await destination(`/events/${KEY}/rsvp`, "DELETE", referer)).toBe(`/e/${KEY}`);
  });
});
