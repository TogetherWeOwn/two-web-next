import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PARITY_ORIGIN,
  PARITY_WEBCAL_ORIGIN,
  normalizeParityOrigins,
} from "./kit-parity-origin.mjs";

const STAGING = "https://next.togetherweown.com";
const KIT = "http://127.0.0.1:8788";

test("webcal and https origins normalize to distinct tokens", () => {
  assert.notEqual(PARITY_WEBCAL_ORIGIN, PARITY_ORIGIN);
  const normalized = normalizeParityOrigins(
    `<a href="webcal://next.togetherweown.com/events.ics">sub</a>` +
      `<a href="https://next.togetherweown.com/events.ics">dl</a>`,
    KIT,
    STAGING,
  );
  assert.ok(normalized.includes(PARITY_WEBCAL_ORIGIN));
  assert.ok(normalized.includes(PARITY_ORIGIN));
});

test("a Kit page with the wrong feed scheme never compares equal", () => {
  const hono = normalizeParityOrigins(
    `<a href="webcal://next.togetherweown.com/events.ics">sub</a>`,
    KIT,
    STAGING,
  );
  for (const wrong of [
    `<a href="https://next.togetherweown.com/events.ics">sub</a>`,
    `<a href="http://next.togetherweown.com/events.ics">sub</a>`,
  ]) {
    assert.notEqual(normalizeParityOrigins(wrong, KIT, STAGING), hono);
  }
});

test("identical schemes on both sides still match", () => {
  const hono = normalizeParityOrigins(
    `<a href="webcal://next.togetherweown.com/events.ics">sub</a>`,
    KIT,
    STAGING,
  );
  const kit = normalizeParityOrigins(
    `<a href="webcal://127.0.0.1:8788/events.ics">sub</a>`,
    KIT,
    STAGING,
  );
  assert.equal(kit, hono);
});
