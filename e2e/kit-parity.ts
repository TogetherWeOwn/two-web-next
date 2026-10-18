import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalizeParityOrigins } from "../ci/kit-parity-origin.mjs";
import { normalizeSection } from "../ci/kit-section-contract.mjs";
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

// The Kit fixture's synthetic session secret, read from its single source
// (ci/kit-worker-dev.mjs), never duplicated here: rotating the fixture value
// rotates what the member-board journey re-signs with, and a fixture that
// stops supplying a literal fails loud instead of as a guest bounce.
export function kitFixtureSessionSecret(): string {
  const source = readFileSync(
    fileURLToPath(new URL("../ci/kit-worker-dev.mjs", import.meta.url).href),
    "utf8",
  );
  const secret = source.match(/SESSION_SECRET: "([^"]+)"/)?.[1];
  if (!secret) throw new Error("kit-parity: ci/kit-worker-dev.mjs supplies no SESSION_SECRET");
  return secret;
}

// Whether the Kit parity fixture owns the member board for this journey.
// The shipped manifest now owns the board on Kit for deployed workers too,
// so the fixture flag (ci/kit-worker-dev.mjs, honoured only on loopback by
// fixtureManifestFor in src/route-ownership.ts) is redundant for this entry
// (rollback is enabled: false); it stays pinned here so a fixture that
// stops owning the board fails loud instead of silently returning to a
// Hono-vs-Hono proof. Read from the fixture config's single source, like
// the session secret above.
export function kitFixtureOwnsMemberBoard(): boolean {
  const source = readFileSync(
    fileURLToPath(new URL("../ci/kit-worker-dev.mjs", import.meta.url).href),
    "utf8",
  );
  return /KIT_PARITY_FIXTURE_MEMBER_BOARD: "true"/.test(source);
}

// Whether the Kit parity fixture owns the live event detail for its journey.
// The shipped manifest keeps GET /e/:key disabled until the RSVP companion
// passes, so the fixture flag alone enables the Kit load on the loopback
// worker; the journey asserts the Kit marker on that target, so a fixture
// that stops owning the route fails loud instead of proving Hono-vs-Hono.
export function kitFixtureOwnsEventDetail(): boolean {
  const source = readFileSync(
    fileURLToPath(new URL("../ci/kit-worker-dev.mjs", import.meta.url).href),
    "utf8",
  );
  return /KIT_PARITY_FIXTURE_EVENT_DETAIL: "true"/.test(source);
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

// The member board's ranked table, extracted and given the shared
// framework-tolerant treatment (ci/kit-section-contract.mjs) so the Hono
// and Kit tables can be compared as contracts, not bytes. Throws when a
// body carries no table — an empty board ("Nobody is ranked …") must fail
// a ranked-content assertion, never pass it by absence.
export function memberBoardTable(html: string): string {
  const match = html.match(/<table(?:\s[^>]*)?>[\s\S]*?<\/table>/);
  if (!match) throw new Error("member board table is missing");
  return normalizeSection(match[0]);
}

export interface MemberBoardDataRow {
  rank: unknown;
  username: unknown;
  count: unknown;
  isViewer: unknown;
}

// Rows from a SvelteKit `__data.json` body. Kit serves the load's return
// value devalue-flattened per node (`data: [{rows: 4, …}, …, [5], {rank:
// 7, …}, …]`): object values are indices into the same flattened array.
// Resolve exactly one level — the node carrying `rows`, then each row's
// rank/username/count/isViewer — so a `200 {}` or `rows: []` payload fails
// the shape assertion instead of passing on status alone.
export function memberBoardDataRows(text: string): MemberBoardDataRow[] {
  const payload: unknown = JSON.parse(text);
  const nodes =
    payload !== null && typeof payload === "object"
      ? (payload as { nodes?: unknown }).nodes
      : undefined;
  if (!Array.isArray(nodes)) throw new Error("member board __data.json carries no data nodes");
  for (const node of nodes) {
    if (node === null || typeof node !== "object") continue;
    const data = (node as { data?: unknown }).data;
    if (!Array.isArray(data)) continue;
    for (const entry of data) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const rowsRef = (entry as Record<string, unknown>).rows;
      if (typeof rowsRef !== "number") continue;
      const rowRefs: unknown = data[rowsRef];
      if (!Array.isArray(rowRefs))
        throw new Error("member board __data.json rows is not a flattened array");
      return rowRefs.map((ref) => {
        const row: unknown = typeof ref === "number" ? data[ref] : undefined;
        if (row === null || typeof row !== "object" || Array.isArray(row))
          throw new Error("member board __data.json row is not a flattened object");
        const fields = row as Record<string, unknown>;
        const resolved: MemberBoardDataRow = {
          rank: undefined,
          username: undefined,
          count: undefined,
          isViewer: undefined,
        };
        for (const key of ["rank", "username", "count", "isViewer"] as const) {
          const valueRef = fields[key];
          if (typeof valueRef !== "number")
            throw new Error(`member board __data.json row carries no ${key}`);
          resolved[key] = data[valueRef];
        }
        return resolved;
      });
    }
  }
  throw new Error("member board __data.json carries no rows");
}

export const PARITY_VIEWPORTS = [
  { name: "desktop", size: { width: 1280, height: 800 } },
  { name: "mobile", size: { width: 390, height: 844 } },
] as const;
