#!/usr/bin/env node
// Signed-cookie vectors for route parity: every cookie src/ signs with
// hono/cookie, signed with a fixed fixture secret. A second renderer must
// produce and accept the same bytes. `--write` regenerates
// test/fixtures/parity/signed-cookies.json; the default checks it.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSignedCookie } from "hono/cookie";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const VECTORS_PATH = "test/fixtures/parity/signed-cookies.json";
export const VECTOR_SECRET = "parity-signed-cookie-vector-secret-not-a-real-key";
const SIGN_CALL = /(?:setSignedCookie\(\s*c\s*,\s*|generateSignedCookie\(\s*)([A-Z_][A-Z0-9_]*)/g;
const OPTIONS = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" };
// Representative plaintexts: what each cookie carries in production, plus one
// value with every character class the signer must encode.
const SAMPLES = {
  "__Host-two_session": `two_${"parityVectorSession".padEnd(43, "0")}`,
  "__Host-two_session_status": "parity-status-key-0123456789abcdef",
  "__Host-two_oauth_state": "parity-oauth-state-0123456789abcdef",
  "__Host-two_join_state": "parity-join-state-0123456789abcdef",
  "__Host-two_join_source": "discord-widget",
  "__Host-two_join_next": "/events/01J00000000000000000000001",
  "__Host-two_login_next": "/profile",
  "__Host-two_login_intended": "/admin/events?page=2",
  "__Host-two_join_result": "joined",
  "__Host-two_expired_write": "pending|/events/01J00000000000000000000001",
};
const SPECIAL = "/events?q=a b&x=|;,%ü";

function sourceFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Cookie names signed anywhere under src/, resolved from their constants. */
export function signedCookieNames(root = repo) {
  const files = sourceFiles(join(root, "src")).map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));
  const literal = (constant) => {
    const pattern = new RegExp(`const ${constant}\\s*(?::\\s*string\\s*)?=\\s*"([^"]+)"`);
    for (const file of files) {
      const match = file.text.match(pattern);
      if (match) return match[1];
    }
    throw new Error(`Cannot resolve signed cookie constant ${constant}`);
  };
  const names = new Map();
  for (const file of files) {
    for (const match of file.text.matchAll(SIGN_CALL)) {
      const name = literal(match[1]);
      const sources = names.get(name) ?? new Set();
      sources.add(file.path);
      names.set(name, sources);
    }
  }
  return new Map([...names].sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildSignedCookieVectors(root = repo) {
  const cookies = [];
  for (const [name, sources] of signedCookieNames(root)) {
    const sample = SAMPLES[name];
    if (!sample)
      throw new Error(
        `Add a representative value for signed cookie ${name} to ci/parity/signed-cookies.mjs`,
      );
    const vectors = [];
    for (const value of [sample, SPECIAL]) {
      const header = await generateSignedCookie(name, value, VECTOR_SECRET, OPTIONS);
      const encoded = header.split(";")[0].slice(name.length + 1);
      vectors.push({ value, cookieValue: encoded, header });
    }
    cookies.push({ name, signedIn: [...sources].sort(), vectors });
  }
  return {
    secret: VECTOR_SECRET,
    library: "hono/cookie generateSignedCookie",
    options: OPTIONS,
    cookies,
  };
}

/** The committed vectors match a fresh build (parsed: Biome owns the layout). */
export async function signedCookieVectorsCurrent(root = repo) {
  const committed = JSON.parse(readFileSync(join(root, VECTORS_PATH), "utf8"));
  return JSON.stringify(committed) === JSON.stringify(await buildSignedCookieVectors(root));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const target = join(repo, VECTORS_PATH);
  if (process.argv.includes("--write")) {
    writeFileSync(target, `${JSON.stringify(await buildSignedCookieVectors(), null, 2)}\n`);
    execFileSync(join(repo, "node_modules/.bin/biome"), ["format", "--write", target], {
      stdio: "ignore",
    });
    console.log(`wrote ${VECTORS_PATH}`);
  } else if (!(await signedCookieVectorsCurrent())) {
    console.error(
      `${VECTORS_PATH} is stale: run node ci/parity/signed-cookies.mjs --write and review the diff`,
    );
    process.exitCode = 1;
  } else console.log(`${VECTORS_PATH}: current`);
}
