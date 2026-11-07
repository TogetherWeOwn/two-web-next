// On-disk format of a route-parity recording (docs/kit-parity-gates.md,
// "Pure-Hono route parity goldens"). Most vectors repeat the same security
// headers, so each shared field is stored once in the `shared` table of
// index.json, keyed by a prefix of the sha256 of its JSON, and the vector keeps
// only `"=<key>"`. A full set stays small enough for GitHub's PR diff and the
// diff-based review bots; a changed CSP is one table line, not 2,563.
import { createHash } from "node:crypto";

export const SHARED_FIELDS = [
  ["request", "headers"],
  ["response", "headers"],
  ["response", "setCookies"],
  ["response", "body"],
];
const REF = "=";
const KEY_LENGTH = 16;

function mapShared(record, fn) {
  const copy = { ...record };
  for (const [part, field] of SHARED_FIELDS) {
    if (copy[part]?.[field] !== undefined)
      copy[part] = { ...copy[part], [field]: fn(copy[part][field], `${part}.${field}`) };
  }
  return copy;
}

/** files: Map<file, {vectorId: record}> → { shared, files } with every shared field a reference. */
export function packRecording(files) {
  const table = new Map();
  const packed = new Map();
  for (const [file, vectors] of files) {
    const out = {};
    for (const [id, record] of Object.entries(vectors)) {
      out[id] = mapShared(record, (value) => {
        const json = JSON.stringify(value);
        const key = createHash("sha256").update(json).digest("hex").slice(0, KEY_LENGTH);
        if (table.has(key) && table.get(key) !== json)
          throw new Error(`Route-parity shared key ${key} collides; lengthen KEY_LENGTH`);
        table.set(key, json);
        return `${REF}${key}`;
      });
    }
    packed.set(file, out);
  }
  const shared = Object.fromEntries(
    [...table.keys()].sort().map((key) => [key, JSON.parse(table.get(key))]),
  );
  return { shared, files: packed };
}

/** Inverse of packRecording. Fails on an inline value, a dangling key or an unused table entry. */
export function expandRecording(files, shared) {
  const used = new Set();
  const expanded = new Map();
  for (const [file, vectors] of files) {
    const out = {};
    for (const [id, record] of Object.entries(vectors)) {
      out[id] = mapShared(record, (ref, field) => {
        if (typeof ref !== "string" || !ref.startsWith(REF))
          throw new Error(`${file}#${id} ${field} is not a shared-table reference`);
        const key = ref.slice(REF.length);
        if (!Object.hasOwn(shared, key))
          throw new Error(`${file}#${id} ${field} references missing shared key ${key}`);
        used.add(key);
        return shared[key];
      });
    }
    expanded.set(file, out);
  }
  const unused = Object.keys(shared).filter((key) => !used.has(key));
  if (unused.length)
    throw new Error(`Route-parity shared table has unused entries: ${unused.join(", ")}`);
  return expanded;
}

// One line per head field and per row: a changed vector or table entry is a
// one-line diff.
export function goldenJson(head, sections) {
  const line = ([name, value]) => ` ${JSON.stringify(name)}: ${JSON.stringify(value)}`;
  const parts = Object.entries(head).map(line);
  for (const [key, rows] of Object.entries(sections)) {
    const body = Array.isArray(rows)
      ? rows.map((row) => `  ${JSON.stringify(row)}`)
      : Object.entries(rows).map((entry) => ` ${line(entry)}`);
    const [open, close] = Array.isArray(rows) ? ["[", "]"] : ["{", "}"];
    parts.push(` ${JSON.stringify(key)}: ${open}\n${body.join(",\n")}\n ${close}`);
  }
  return `{\n${parts.join(",\n")}\n}\n`;
}
