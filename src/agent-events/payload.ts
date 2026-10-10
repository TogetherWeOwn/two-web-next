import { sha256Hex } from "../bot/signer";
import { containsControlCharacters, wallToUtc } from "../admin/validation";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()): string {
  let t = "";
  for (let n = now, i = 0; i < 10; i++, n = Math.floor(n / 32)) t = CROCKFORD[n % 32] + t;
  const r = crypto.getRandomValues(new Uint8Array(16));
  return t + [...r].map((b) => CROCKFORD[b % 32]).join("");
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

// Keep explicit keys safe for PostgreSQL text/varchar(26), including denied
// audits and lock names. Never truncate or repair a key into another identity.
export const storedEventKey = (key: unknown): string | null =>
  typeof key === "string" && key !== "" && key.length <= 26 && !/[\u0000\uD800-\uDFFF]/u.test(key)
    ? key
    : null;

// Nesting bound for the payload digest: comfortably above every real agent
// event body (3 levels), far below stack exhaustion (~10k frames in a Worker).
export const MAX_DIGEST_DEPTH = 100;
export class PayloadTooDeepError extends Error {}

function sortRecursive(v: unknown, depth = 0): unknown {
  // Untrusted nesting is bounded: without this, an admitted deeply nested
  // body recurses until the worker throws RangeError (answered 500). Past the
  // bound the digest refuses with a typed error the caller answers 422.
  if (depth > MAX_DIGEST_DEPTH)
    throw new PayloadTooDeepError(`The request body nests deeper than ${MAX_DIGEST_DEPTH} levels.`);
  if (Array.isArray(v)) return v.map((e) => sortRecursive(e, depth + 1));
  if (isPlainObject(v))
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, sortRecursive(v[k], depth + 1)]),
    );
  return v;
}

// The identity of a request payload: recursive key-sorted JSON, hashed. Key order never
// distinguishes two payloads.
export const digest = (body: unknown): Promise<string> =>
  sha256Hex(JSON.stringify(sortRecursive(body)));

export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
function validWall(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = WALL.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === mo - 1 &&
    dt.getUTCDate() === d &&
    h < 24 &&
    mi < 60
  );
}

export type Fields = {
  title: string;
  game: string | null;
  description: string | null;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location: string;
  capacity: number | null;
};

// Same rules as the human event form (parseEventForm in src/admin/validation):
// trimmed before the required/length checks, and title/description/location
// refuse control and invisible/bidi characters via the shared predicate.
export function validateFields(
  raw: unknown,
): { ok: true; fields: Fields } | { ok: false; errors: Record<string, string[]> } {
  const e: Record<string, string[]> = {};
  const bad = (k: string, m: string) => (e[k] ??= []).push(m);
  if (!isPlainObject(raw))
    return { ok: false, errors: { fields: ["An object of event `fields` is required."] } };
  const str = (k: string, max: number, required: boolean): string | null => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") {
      if (required) bad(k, `The ${k} field is required.`);
      return null;
    }
    if (typeof v !== "string") {
      bad(k, `The ${k} field must be a string.`);
      return null;
    }
    // Like the human form's str(): whitespace-only is missing (required) or
    // null (optional), and the limit measures the trimmed value.
    const t = v.trim();
    if (t === "") {
      if (required) bad(k, `The ${k} field is required.`);
      return null;
    }
    if ([...t].length > max) {
      bad(k, `The ${k} field must not be greater than ${max} characters.`);
      return null;
    }
    return t;
  };
  const title = str("title", 100, true);
  const game = str("game", 100, false);
  const description = str("description", 1000, false);
  const location = str("location", 255, true);
  const timezone = str("timezone", 64, true);
  // Like the human form, check the raw submitted text (trim removes BOM): tab,
  // LF and CR and genuine emoji ZWJ sequences stay accepted.
  for (const k of ["title", "description", "location"] as const) {
    const v = raw[k];
    if (typeof v === "string" && v !== "" && containsControlCharacters(v))
      bad(k, `The ${k} field must not contain control or invisible characters.`);
  }
  if (timezone !== null) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: timezone });
    } catch {
      bad("timezone", "The timezone field must be a valid timezone.");
    }
  }
  const wall = (k: "starts_at" | "ends_at"): string | null => {
    const v = raw[k];
    if (v === undefined || v === null || v === "") {
      bad(k, `The ${k} field is required.`);
      return null;
    }
    if (!validWall(v)) {
      bad(k, `The ${k} field must be a real wall time formatted YYYY-MM-DD HH:MM.`);
      return null;
    }
    return v;
  };
  const startsAt = wall("starts_at");
  const endsAt = wall("ends_at");
  if (startsAt && endsAt && endsAt <= startsAt)
    bad("ends_at", "The ends_at field must be a date after starts_at.");
  let capacity: number | null = null;
  if (raw.capacity !== undefined && raw.capacity !== null) {
    if (typeof raw.capacity !== "number" || !Number.isInteger(raw.capacity) || raw.capacity < 1)
      bad("capacity", "The capacity field must be an integer of at least 1.");
    else if (raw.capacity > 2147483647)
      bad("capacity", "The capacity field must not be greater than 2147483647.");
    else capacity = raw.capacity;
  }
  if (timezone && !e.timezone) {
    for (const [name, value] of [
      ["starts_at", startsAt],
      ["ends_at", endsAt],
    ] as const) {
      if (value) {
        try {
          wallToUtc(value, timezone);
        } catch {
          bad(name, `The ${name} field names a time that never occurred in ${timezone}.`);
        }
      }
    }
  }
  if (Object.keys(e).length) return { ok: false, errors: e };
  return {
    ok: true,
    fields: {
      title: title!,
      game,
      description,
      starts_at: startsAt!,
      ends_at: endsAt!,
      timezone: timezone!,
      location: location!,
      capacity,
    },
  };
}
