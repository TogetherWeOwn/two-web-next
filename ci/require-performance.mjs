// Fail-closed required check: consume GitHub needs.<job>.result values.
// Failure, cancellation, skipping and missing results must all exit nonzero.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export function gate(results, output = console) {
  const bad = Object.entries(results).filter(([, value]) => value !== 'success');
  for (const [name, value] of bad) {
    output.error(`performance gate: ${name} did not succeed (result: ${value ?? 'missing'})`);
  }
  if (bad.length) return 1;
  output.log('performance gate: lighthouse and bundle-budget both succeeded.');
  return 0;
}

function selftest() {
  const cases = [
    ['both succeed', { lighthouse: 'success', 'bundle-budget': 'success' }, 0, null],
    ['lighthouse failure blocks', { lighthouse: 'failure', 'bundle-budget': 'success' }, 1, 'lighthouse'],
    ['bundle failure blocks', { lighthouse: 'success', 'bundle-budget': 'failure' }, 1, 'bundle-budget'],
    // A skipped Lighthouse run must not read green: the required gate fails.
    ['skipped lighthouse blocks', { lighthouse: 'skipped', 'bundle-budget': 'success' }, 1, 'lighthouse'],
    ['cancelled blocks', { lighthouse: 'cancelled', 'bundle-budget': 'success' }, 1, 'lighthouse'],
    ['missing result blocks', { lighthouse: undefined, 'bundle-budget': 'success' }, 1, 'lighthouse'],
  ];
  let count = 0;
  for (const [name, results, expected, message] of cases) {
    const errors = [];
    const code = gate(results, { log() {}, error(text) { errors.push(text); } });
    assert.equal(code, expected, name);
    if (message) assert.ok(errors.some((text) => text.includes(message)), `${name}: missing diagnostic`);
    count += 1;
    console.log(`PASS ${name}`);
  }
  console.log(`performance gate selftest: ${count} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , ...args] = process.argv;
  if (args.length === 1 && args[0] === '--selftest') {
    process.exitCode = selftest();
  } else if (args.length === 2) {
    process.exitCode = gate({ lighthouse: args[0], 'bundle-budget': args[1] });
  } else {
    console.error('Usage: node ci/require-performance.mjs [--selftest | <lighthouse-result> <bundle-result>]');
    process.exitCode = 2;
  }
}
