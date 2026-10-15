import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeParityOrigins } from "../ci/kit-parity-origin.mjs";
import { STAGING_APP_URL } from "../src/qa";

// Shared helpers for the Kit parity project
// (playwright.kit-parity.config.ts, e2e/kit-parity/parity.spec.ts): the same
// no-login journeys run against the Hono worker and the built Kit Worker,
// and every comparison is origin-normalized before it can pass.
//
// The Hono test worker maps local HTTPS transport to the virtual staging
// origin (e2e/worker.ts), so Hono bodies pin STAGING_APP_URL. The Kit fixture
// serves its own APP_URL (ci/kit-worker-dev.mjs). Host strings therefore
// differ by design; normalize both to one placeholder before comparing, so a
// host-string diff can never hide a contract diff — or fake a pass.
export interface ParityTarget {
  name: "hono" | "kit";
  origin: string;
  ignoreHTTPSErrors: boolean;
}

export const HONO_ORIGIN = "https://localhost:8787";
// One variable owns the Kit fixture address: KIT_WORKER_ORIGIN wins when set,
// otherwise it derives from KIT_WORKER_PORT (the same variable
// ci/kit-worker-dev.mjs listens on), so setting one without the other cannot
// silently point the spec at a dead origin.
export const KIT_ORIGIN =
  process.env.KIT_WORKER_ORIGIN ?? `http://127.0.0.1:${process.env.KIT_WORKER_PORT ?? "8788"}`;

export function parityTargets(): ParityTarget[] {
  return [
    { name: "hono", origin: HONO_ORIGIN, ignoreHTTPSErrors: true },
    { name: "kit", origin: KIT_ORIGIN, ignoreHTTPSErrors: false },
  ];
}

// Expected Kit renderer marker for a path, derived from the shipped manifest
// (src/route-ownership.ts), never hard-coded: flipping `enabled` flips the
// gate for the right reason. Hono never carries the marker. Derived per path
// (query stripped), field-order independent — the same derivation as
// ci/kit-parity-gates.mjs expectedMarkerFor, minus its fail-closed throw for
// entry-less parity routes (this helper only ever asks about listed routes).
export function expectedKitMarker(path: string): string | null {
  const source = readFileSync(
    fileURLToPath(new URL("../src/route-ownership.ts", import.meta.url).href),
    "utf8",
  );
  const base = path.split(/[?#]/)[0] ?? path;
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match =
    source.match(new RegExp(`path:\\s*"${escaped}"[^}]*enabled:\\s*(true|false)`)) ??
    source.match(new RegExp(`enabled:\\s*(true|false)[^}]*path:\\s*"${escaped}"`));
  if (!match) return null;
  return match[1] === "true" ? "kit" : null;
}

export function normalizeOrigin(body: string, origin: string): string {
  // Feed links also ship a webcal:// variant (webcalUrl in
  // src/events/feeds.ts rewrites the http(s) scheme to webcal://), so the
  // bare https/http origin never matches the subscribe href. Normalize both
  // schemes, or the cross-target section comparison fails on host bytes that
  // differ by design (staging origin vs Kit fixture origin).
  //
  // The webcal variants map to a DISTINCT token, replaced BEFORE the bare
  // origins: the subscribe link (webcal) and the .ics download link (https)
  // share the /events.ics path, so one shared placeholder would let a Kit
  // page that emits the wrong scheme compare equal. The scheme stays part of
  // the compared contract. Single source of truth is
  // ci/kit-parity-origin.mjs, pinned by node:test without a browser runner,
  // so reverting to one shared token fails that suite.
  return normalizeParityOrigins(body, origin, STAGING_APP_URL);
}

const SECRET_PATTERNS = [/X-TWO-QA-Auth/i, /__Host-two_session\s*=/, /DISCORD_BOT_TOKEN/i];

export function scrubSecrets(...bodies: string[]): string[] {
  const hits: string[] = [];
  for (const body of bodies) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(body)) hits.push(String(pattern));
    }
  }
  return hits;
}

export const PARITY_VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 800 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;
