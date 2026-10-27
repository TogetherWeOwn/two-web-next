import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertJourney } from "./check-auth-perf.mjs";

// Defense in depth beyond secret-shaped guards: raw QA/cookie values may have
// no recognizable prefix. The writer must compare the known in-memory values.
for (const secret of [
  "synthetic-qa-writer-canary",
  "synthetic-cookie-writer-canary",
  'synthetic-quoted-"cookie\\\ncanary',
]) {
  test("writer refuses a known raw canary before either artifact write", (t) => {
    const cwd = mkdtempSync(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "auth-perf-writer-"),
    );
    t.after(() => rmSync(cwd, { recursive: true, force: true }));
    const moduleUrl = new URL("./check-auth-perf.mjs", import.meta.url).href;
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import {readFileSync} from 'node:fs';
         import {summarize, writeLedger} from ${JSON.stringify(moduleUrl)};
         const secret = JSON.parse(readFileSync(0, 'utf8'));
         let output = '';
         const code = writeLedger(summarize([{name:'member-rsvp',status:'passed',reason:secret}]),
           {secrets:[secret],stdout:{write(text){output += text;}}});
         console.log(JSON.stringify({code,output}));`,
      ],
      { cwd, env: {}, input: JSON.stringify(secret), encoding: "utf8", timeout: 5_000 },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.code, 1);
    assert.equal(result.output, "auth perf gate: secret-shaped content in ledger — failing.\n");
    assert.ok(!result.output.includes(secret));
    assert.deepEqual(readdirSync(cwd), []);
  });
}

for (const elapsedMs of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, "0"]) {
  test(`journey assertions reject non-measurements (${String(elapsedMs)})`, () => {
    const failures = assertJourney({
      id: "member-rsvp",
      samples: [
        {
          status: 200,
          contentType: "text/html",
          html: '<button>Sign out</button><span data-testid="event-going-count">3</span>',
          elapsedMs,
        },
      ],
      budget: { maxMedianMs: 500, maxSingleMs: 1000 },
    });
    assert.ok(failures.some((failure) => failure.includes("not measurable")));
  });
}
