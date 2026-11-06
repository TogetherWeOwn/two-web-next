#!/usr/bin/env node
// Run with node --import tsx. No network other than the validated disposable DB.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseSigned } from "hono/utils/cookie";
import { createEmberCapture } from "../test/helpers/ember-capture.ts";
import { captureManifest } from "../test/helpers/ember-capture-data.ts";
import { SESSION_COOKIE } from "../src/session-cookie.ts";
import { hashToken } from "../src/sessions.ts";

const command = process.argv.slice(2);
try {
  if (command.length !== 1 || !["manifest", "verify"].includes(command[0]))
    throw new Error("usage");
  const expected = captureManifest();
  const committed = JSON.parse(
    readFileSync(new URL("../test/fixtures/ember-capture-v1.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(expected, committed);
  if (command[0] === "manifest") {
    console.log(JSON.stringify(expected, null, 2));
  } else {
    const fixture = await createEmberCapture({
      seedId: process.env.CAPTURE_SEED_ID,
      databaseUrl: process.env.DATABASE_URL,
      appUrl: process.env.APP_URL,
    });
    let cleanup = false;
    try {
      const first = fixture.manifest;
      const secret = randomBytes(32).toString("base64url");
      for (const persona of ["member", "moderator"]) {
        const cookie = await fixture.session(persona, secret);
        const parsed = await parseSigned(cookie, secret);
        const token = parsed[SESSION_COOKIE];
        assert.equal(typeof token, "string");
        const rows = await fixture.client`select member, moderator,
          expires_at > now() as unexpired,
          created_at > now() - interval '24 hours' as young,
          expires_at <= now() + interval '2 hours' as bounded
          from web_sessions where token_hash = ${await hashToken(token)}`;
        assert.equal(rows.length, 1);
        assert.deepEqual(
          { ...rows[0] },
          {
            member: true,
            moderator: persona === "moderator",
            unexpired: true,
            young: true,
            bounded: true,
          },
        );
      }
      // Hotzone and leaderboard GETs append anonymous views outside the seed hash.
      await fixture.client`insert into board_view_logs
        (normalized_board_key, scope, season, result_count)
        values ('hotzones/joins', 'all', 'all', 2)`;
      assert.equal((await fixture.client`select count(*)::int as n from board_view_logs`)[0].n, 1);
      await fixture.client`delete from featured_contents where id = 1`;
      await assert.rejects(fixture.verify(), /capture_invalid/);
      const second = await fixture.resetAndSeed();
      assert.deepEqual(second, first);
      assert.equal((await fixture.client`select count(*)::int as n from web_sessions`)[0].n, 0);
      assert.equal((await fixture.client`select count(*)::int as n from board_view_logs`)[0].n, 0);
      await fixture.dispose();
      cleanup = true;
      console.log(
        JSON.stringify({
          version: 1,
          seedId: first.seedId,
          verdict: "pass",
          cleanSeeds: 2,
          dataHash: first.dataHash,
          bindingsHash: first.bindingsHash,
          routeStates: first.routeStates.length,
          localSessions:
            "member/moderator roles and bounded real-clock expiry verified; reset removed sessions",
          cleanup: "owned schema dropped",
          pilot: "not_run",
        }),
      );
    } finally {
      if (!cleanup) await fixture.dispose();
    }
  }
} catch (error) {
  // Fixed code allowlist only, never driver messages or arbitrary exception properties.
  const code = [
    "ECONNREFUSED",
    "28P01",
    "28000",
    "42P01",
    "23505",
    "22P02",
    "ERR_ASSERTION",
  ].includes(error?.code)
    ? error.code
    : "fixture_prerequisite";
  console.error(
    `capture_invalid (${code}): verify invocation, committed manifest and disposable fixture prerequisites; stop on credential failure (no fallback)`,
  );
  process.exitCode = 1;
}
