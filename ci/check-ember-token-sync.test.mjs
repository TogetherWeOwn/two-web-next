import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "ci/check-ember-token-sync.mjs");
const HONO_TOKENS = join(ROOT, "public/theme-tokens.css");

function lastJsonLine(out) {
  return JSON.parse(out.trim().split("\n").at(-1));
}

test("ember token sync selftest passes on the wired sheets", () => {
  const out = execFileSync("node", [SCRIPT, "--selftest"], { encoding: "utf8" });
  const parsed = lastJsonLine(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "selftest");
  assert.match(parsed.summary, /ember token sync selftest ok/);
});

test("ember token sync check passes on the wired sheets", () => {
  const out = execFileSync("node", [SCRIPT], { encoding: "utf8" });
  const parsed = lastJsonLine(out);
  assert.equal(parsed.ok, true);
  assert.match(parsed.summary, /ember token sync ok/);
});

test("a drifted sheet literal fails the check", () => {
  const pristine = readFileSync(HONO_TOKENS, "utf8");
  assert.ok(pristine.includes("#f6f1ea"), "fixture expects the kit text literal in the sheet");
  try {
    writeFileSync(HONO_TOKENS, pristine.replace("#f6f1ea", "#ffffff"));
    assert.throws(
      () => execFileSync("node", [SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      (error) => {
        assert.equal(error.status, 1);
        const parsed = lastJsonLine(error.stdout);
        assert.equal(parsed.ok, false);
        assert.match(parsed.error, /--color-text/);
        return true;
      },
    );
  } finally {
    writeFileSync(HONO_TOKENS, pristine);
  }
});

test("unknown flags are a usage error", () => {
  assert.throws(
    () => execFileSync("node", [SCRIPT, "--bogus"], { encoding: "utf8" }),
    (error) => {
      assert.equal(error.status, 2);
      return true;
    },
  );
});
