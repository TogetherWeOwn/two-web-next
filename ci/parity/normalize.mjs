// Response normalisation for route-parity goldens. Pure: no I/O, so
// ci/parity/parity.test.mjs pins every masking rule.
import { createHash } from "node:crypto";

export const MASK = "<masked>";
/** Per-request values that never belong to the contract. */
export const MASKED_HEADERS = new Set(["date", "x-request-id", "cf-ray"]);
/** Added by ci/parity/harness.ts; moved out of the header set. */
export const HARNESS_HEADERS = ["x-parity-route", "x-parity-alerts", "x-parity-outbound"];
const CSP_HEADERS = new Set(["content-security-policy", "content-security-policy-report-only"]);
const NONCE_SOURCE = /'nonce-[^']*'/g;
const NONCE_ATTRIBUTE = /\bnonce="[^"]*"/g;
// `wrangler dev` asset ETags hash the absolute file path and its mtime
// (miniflare's asset manifest), so they change with every checkout. Deployed
// assets hash content instead. The app's own ETags are 64-hex sha256, so the
// 32-hex form identifies the asset layer; the W/ prefix and quotes are kept.
const ASSET_ETAG = /^(W\/)?"[0-9a-f]{32}"$/;
export const ASSET_ETAG_MASK = "<asset-etag>";
const TEXTUAL =
  /^(text\/|application\/(json|[\w.+-]*\+json|javascript|xml|[\w.+-]*\+xml|x-ndjson|manifest\+json))/i;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/** node:http rawHeaders ([name, value, ...]) into a contract record. */
export function normalizeHeaders(rawHeaders) {
  const headers = {};
  const setCookies = [];
  const harness = {};
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = String(rawHeaders[i]).toLowerCase();
    let value = String(rawHeaders[i + 1]);
    if (HARNESS_HEADERS.includes(name)) {
      harness[name] = value;
      continue;
    }
    if (name === "set-cookie") {
      setCookies.push(normalizeSetCookie(value));
      continue;
    }
    if (MASKED_HEADERS.has(name)) value = MASK;
    else if (CSP_HEADERS.has(name)) value = value.replace(NONCE_SOURCE, `'nonce-${MASK}'`);
    else if (name === "retry-after" && /^\d+$/.test(value)) value = "<seconds>";
    else if (name === "etag") value = value.replace(ASSET_ETAG, `$1"${ASSET_ETAG_MASK}"`);
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  const sorted = Object.fromEntries(
    Object.keys(headers)
      .sort()
      .map((name) => [name, headers[name]]),
  );
  return {
    headers: sorted,
    setCookies,
    route: harness["x-parity-route"] ?? null,
    alerts: JSON.parse(harness["x-parity-alerts"] ?? "[]"),
    outbound: JSON.parse(harness["x-parity-outbound"] ?? "[]"),
  };
}

/** Name and attributes kept; the value is masked (empty stays empty: a deletion). */
export function normalizeSetCookie(header) {
  const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const name = eq === -1 ? pair : pair.slice(0, eq);
  const value = eq === -1 ? "" : pair.slice(eq + 1);
  return { name, value: value === "" ? "" : MASK, attributes: attributes.filter(Boolean) };
}

function mergeShapes(shapes) {
  const unique = [...new Map(shapes.map((shape) => [JSON.stringify(shape), shape])).values()];
  if (unique.length === 1) return unique[0];
  return { oneOf: unique.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) };
}

/** Keys and value types, not values: the comparison for data-dependent JSON. */
export function jsonShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.length === 0 ? [] : [mergeShapes(value.map(jsonShape))];
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, jsonShape(value[key])]),
    );
  }
  return typeof value;
}

/**
 * Body record: sha256 of the normalised bytes, plus the JSON shape for JSON.
 * Nonces and the request id are masked first; both are per-request values a
 * second renderer cannot reproduce.
 */
export function describeBody(buffer, contentType, requestId) {
  if (buffer.length === 0) return { kind: "empty", bytes: 0 };
  const type = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (!TEXTUAL.test(type)) return { kind: "binary", bytes: buffer.length, sha256: sha256(buffer) };
  let text = buffer.toString("utf8").replace(NONCE_ATTRIBUTE, `nonce="${MASK}"`);
  text = text.replace(NONCE_SOURCE, `'nonce-${MASK}'`);
  if (requestId) text = text.replaceAll(requestId, "<request-id>");
  const body = { kind: "text", bytes: Buffer.byteLength(text), sha256: sha256(text) };
  if (type === "application/json" || type.endsWith("+json")) {
    try {
      return { ...body, kind: "json", shape: jsonShape(JSON.parse(text)) };
    } catch (error) {
      return { ...body, kind: "json-invalid", error: error.name };
    }
  }
  return body;
}

/** Same FNV-1a 64 as ci/parity/harness.ts stableHex: the request id the harness derives. */
export function stableHex(value) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

/** A per-vector client address, so throttle buckets never span vectors. */
export function clientAddress(vectorKey) {
  const hex = stableHex(`client:${vectorKey}`);
  const octet = (offset) => Number.parseInt(hex.slice(offset, offset + 2), 16);
  return `10.${octet(0)}.${octet(2)}.${octet(4)}`;
}
