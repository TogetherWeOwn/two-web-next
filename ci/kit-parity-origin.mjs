#!/usr/bin/env node
// Pure origin-normalization for Kit parity comparisons (no I/O, no network).
//
// Both e2e/kit-parity.ts (Playwright) and the node:test suite import this so
// the webcal/https distinction is pinned without a browser runner. The Hono
// test worker pins STAGING_APP_URL while the Kit fixture serves its own
// origin; host strings differ by design, so both are normalized before any
// comparison — but the feed subscribe link (webcal://) and the .ics download
// link (https://) share the /events.ics path, so they MUST map to distinct
// tokens. One shared placeholder would let a Kit page that emits the wrong
// scheme compare equal (Paperclip Review 4/5 on head 1c1df2ad).
import { STAGING_ORIGIN } from "./operator-constants.mjs";
export const PARITY_ORIGIN = "PARITY_ORIGIN";
export const PARITY_WEBCAL_ORIGIN = "PARITY_WEBCAL_ORIGIN";

const toWebcal = (url) => url.replace(/^https?:\/\//, "webcal://");

export function normalizeParityOrigins(body, origin, stagingUrl) {
  return body
    .split(toWebcal(origin))
    .join(PARITY_WEBCAL_ORIGIN)
    .split(toWebcal(stagingUrl))
    .join(PARITY_WEBCAL_ORIGIN)
    .split(origin)
    .join(PARITY_ORIGIN)
    .split(stagingUrl)
    .join(PARITY_ORIGIN);
}

function selftest() {
  let count = 0;
  const check = (name, condition) => {
    if (!condition) throw new Error(`selftest FAIL: ${name}`);
    count += 1;
    console.log(`PASS ${name}`);
  };
  const staging = STAGING_ORIGIN;
  const kit = "http://127.0.0.1:8788";
  // Same scheme on both sides still matches.
  check(
    "identical webcal matches",
    normalizeParityOrigins(
      `<a href="webcal://${staging.slice(8)}/events.ics">`,
      staging,
      staging,
    ).includes(PARITY_WEBCAL_ORIGIN),
  );
  // A Kit page that emits https for the subscribe link must NOT compare equal
  // to a Hono page that emits webcal.
  const hono = normalizeParityOrigins(
    `<a href="webcal://next.togetherweown.com/events.ics">sub</a>`,
    kit,
    staging,
  );
  const kitWrong = normalizeParityOrigins(
    `<a href="https://next.togetherweown.com/events.ics">sub</a>`,
    kit,
    staging,
  );
  check("wrong scheme compares unequal", hono !== kitWrong);
  check("webcal and https tokens differ", PARITY_WEBCAL_ORIGIN !== PARITY_ORIGIN);
  console.log(`kit-parity-origin selftest: ${count} cases passed.`);
  return 0;
}

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === "--selftest") {
    process.exitCode = selftest();
  } else if (args.length !== 0) {
    console.error("Usage: node ci/kit-parity-origin.mjs [--selftest]");
    process.exitCode = 2;
  }
}
