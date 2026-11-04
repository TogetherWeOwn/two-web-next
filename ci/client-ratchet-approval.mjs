// Test oracle for generated decreases. Historical allocations remain pinned;
// current aggregate ceilings must follow a replayable measured-decision chain.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CLIENT_FILES, parseDecision, replayDecision } from "./kit-client-ratchet.mjs";

export const INITIAL_CLIENT_BUDGET = {
  js: { maxRawBytes: 261632, maxGzipBytes: 104448, maxFiles: 55 },
  css: { maxRawBytes: 3072, maxGzipBytes: 1280, maxFiles: 4 },
};
const client = (files) => ({
  js: files[CLIENT_FILES[0]].client.js,
  css: files[CLIENT_FILES[1]].client.css,
});
const same = isDeepStrictEqual;

export function approvedClientBudget(root) {
  const dir = join(root, "ci/budgets/decisions/kit-perf");
  const pending = readdirSync(dir)
    .filter((name) => /^auto-client-ratchet-[a-f0-9]{12}\.md$/.test(name))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      const evidence = parseDecision(text);
      const { base } = evidence;
      const result = replayDecision(evidence);
      return { name, before: client(base), after: client(result.files) };
    });
  let approved = structuredClone(INITIAL_CLIENT_BUDGET);
  while (pending.length) {
    // Route-only proposals do not advance aggregate state. Consume them before
    // a lowering from that same state, regardless of source-SHA filename order.
    let index = pending.findIndex(
      (record) => same(record.before, approved) && same(record.after, approved),
    );
    if (index < 0) index = pending.findIndex((record) => same(record.before, approved));
    assert.ok(index >= 0, "measured client decisions do not extend the approved ceiling chain");
    const [record] = pending.splice(index, 1);
    approved = record.after;
  }
  return approved;
}
