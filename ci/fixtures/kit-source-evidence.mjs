import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { STAGING_ORIGIN } from "../operator-constants.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

async function fixtureEntry(entry, worker) {
  // Only the synthetic Request sees the canonical origin. The transport and
  // database stay on loopback, and any attempted outbound HTTP fails the test.
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};
const profiles = {
  normal: {},
  outside: {},
  disabled: { SOURCE_EVIDENCE_VERIFIER_ENABLED: "false" },
  expired: { SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: "1" },
  missing: { SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: "9007199254740991" },
  unavailable: { DATABASE_URL: undefined },
};
let outbound = false;
globalThis.fetch = async () => {
  outbound = true;
  throw new Error("Unexpected outbound source-evidence fixture request");
};
export default {
  async fetch(incoming, env, context) {
    const local = new URL(incoming.url);
    if (local.pathname === "/favicon.ico") return worker.fetch(incoming, env, context);
    const profile = incoming.headers.get("x-fixture-evidence-profile");
    const mode = incoming.headers.get("x-fixture-evidence-owner");
    if (!Object.hasOwn(profiles, profile)) return new Response(null, { status: 400 });
    const bindings = {
      ...env,
      APP_URL: profile === "outside" ? local.origin : ${JSON.stringify(STAGING_ORIGIN)},
      KIT_ROUTE_ADMIN: mode === "on" ? "false" : "true",
      KIT_ROUTE_ADMIN_SOURCE_EVIDENCE: mode === "default" ? undefined :
        String(mode === "on" || mode === "both"),
      ...profiles[profile],
    };
    const url = new URL(bindings.APP_URL);
    url.pathname = local.pathname;
    url.search = local.search;
    const request = new Request(url, incoming);
    request.headers.delete("x-fixture-evidence-profile");
    request.headers.delete("x-fixture-evidence-owner");
    request.headers.set("host", url.host);
    if (request.headers.get("origin") === local.origin) request.headers.set("origin", url.origin);
    const response = await withEnv(bindings, () => worker.fetch(request, bindings, context));
    if (outbound) throw new Error("Source-evidence fixture attempted outbound HTTP");
    return response;
  },
};\n`,
  );
}

export async function assertKitSourceEvidence({ worker, honoWorker, scratch, databaseUrl, start }) {
  const sql = postgres(databaseUrl, { max: 1 });
  const job = randomUUID();
  const source = `sync-event:01${randomBytes(12).toString("hex").toUpperCase()}`;
  const sessionToken = `two_${randomBytes(32).toString("base64url")}`;
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const moderator = String(900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`));
  const token = randomBytes(32).toString("base64url");
  const issued = Date.now();
  const expires = issued + 600_000;
  const fixtureRows = () => sql`select * from queue_failed_jobs where job_id = ${job}`;
  const fixtureSessions = () => sql`select * from web_sessions where user_id = ${moderator}`;

  try {
    const [{ id }] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${job}, 'sync-event', ${source}, 'synthetic private diagnostics') returning id::text`;
    await sql`insert into web_sessions
      (token_hash, status_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
      values (${sessionHash}, ${sessionHash}, ${moderator}, 'Synthetic evidence moderator', true, true,
        now() + interval '1 hour', now())`;
    const cookie = (
      await generateSignedCookie(SESSION_COOKIE, sessionToken, FIXTURE_SECRETS.SESSION_SECRET, {
        path: "/",
        secure: true,
      })
    ).split(";", 1)[0];
    const path = `/admin/queue/source-evidence/${id}`;
    const readAudits = () => sql`select id from activity_log
      where causer_id = ${moderator} or (subject_type = 'queue_failed_jobs' and subject_id = ${id})`;
    const before = await Promise.all([fixtureRows(), fixtureSessions(), readAudits()]);

    const vars = {
      SOURCE_EVIDENCE_VERIFIER_ENABLED: "true",
      SOURCE_EVIDENCE_VERIFIER_TOKEN: token,
      SOURCE_EVIDENCE_VERIFIER_INCIDENT_ID: id,
      SOURCE_EVIDENCE_VERIFIER_ISSUED_AT: String(issued),
      SOURCE_EVIDENCE_VERIFIER_EXPIRES_AT: String(expires),
    };
    const targets = await Promise.all(
      [
        ["hono", honoWorker],
        ["kit", worker],
      ].map(async ([name, main]) => {
        const entry = join(scratch, `source-evidence-${name}.mjs`);
        await fixtureEntry(entry, main);
        return start(name, entry, vars);
      }),
    );

    async function read(
      target,
      mode,
      {
        url = path,
        method = "GET",
        headers,
        body,
        status,
        error,
        profile = "normal",
        exact = true,
      },
    ) {
      const label = `${target.name} ${mode} ${profile} ${method} ${url}`;
      const requestId = "0123456789abcdef";
      const response = await fetch(`${target.origin}${url}`, {
        method,
        body,
        redirect: "manual",
        headers: {
          accept: "text/html",
          "cf-ray": requestId,
          origin: target.origin,
          authorization: `Bearer ${token}`,
          "x-fixture-evidence-owner": mode,
          "x-fixture-evidence-profile": profile,
          ...headers,
        },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      assert.equal(response.status, status, label);
      const transportRefusal = error === "cross_origin" || status === 413;
      assert.equal(
        response.headers.get("x-two-renderer"),
        (mode === "on" || mode === "both") && exact ? "kit" : null,
        label,
      );
      assert.equal(
        response.headers.get("cache-control"),
        transportRefusal ? "no-store, private" : "private, no-store",
        label,
      );
      assert.equal(response.headers.get("vary"), transportRefusal ? "Accept" : null, label);
      assert.equal(response.headers.get("content-type"), "application/json", label);
      assert.equal(response.headers.get("location"), null, label);
      assert.equal(response.headers.getSetCookie().length, 0, label);
      assert.equal(response.headers.get("allow"), status === 405 ? "GET" : null, label);
      assert.equal(response.headers.get("etag"), null, label);
      assert.equal(response.headers.get("x-request-id"), requestId, label);
      assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
      assert.match(
        response.headers.get("content-security-policy") ?? "",
        /form-action 'self'/,
        label,
      );
      if (method === "HEAD") assert.equal(text, "", label);
      else if (status === 413)
        assert.deepEqual(
          JSON.parse(text),
          {
            reason: "payload_too_large",
            message: "Reduce the size of your request and try again.",
            request_id: requestId,
          },
          label,
        );
      else if (error === "cross_origin")
        assert.deepEqual(JSON.parse(text), { error, request_id: requestId }, label);
      else if (error) assert.equal(text, JSON.stringify({ error }), label);
      else {
        const { statementSetHash, observedAt, selects, ...evidence } = JSON.parse(text);
        assert.match(statementSetHash, /^sha256:[a-f0-9]{64}$/, label);
        const [incident] = selects;
        for (const marker of [observedAt, incident.readAt]) {
          assert.ok(Date.parse(marker) >= issued && Date.parse(marker) <= Date.now(), label);
        }
        assert.deepEqual(
          selects,
          [
            {
              index: 0,
              statement: "queue_failed_jobs_by_id",
              rowCount: 1,
              readAt: incident.readAt,
            },
            { index: 1, statement: "events_by_key_exists", rowCount: 0, readAt: null },
          ],
          label,
        );
        assert.deepEqual(
          evidence,
          {
            evidenceOnly: true,
            incidentId: Number(id),
            binding: { kind: "explicit-url", databaseUrlOverride: true },
            expiresAt: new Date(expires).toISOString(),
          },
          label,
        );
        return statementSetHash;
      }
    }

    const [hono, kit] = targets;
    async function compare(options) {
      const direct = await read(hono, "direct", options);
      assert.equal(await read(kit, "off", options), direct);
      assert.equal(await read(kit, "on", options), direct);
      return direct;
    }
    const successfulRead = { status: 200 };
    const expectedHash = await compare(successfulRead);
    assert.equal(await read(kit, "default", successfulRead), expectedHash);
    assert.equal(await read(kit, "both", successfulRead), expectedHash);
    await read(kit, "both", {
      status: 403,
      error: "evidence_forbidden",
      headers: { authorization: "Bearer wrong", cookie },
    });
    await compare({ status: 200, method: "HEAD" });
    for (const profile of ["disabled", "outside"]) {
      await compare({ status: 404, error: "evidence_disabled", profile });
    }
    for (const headers of [
      { authorization: "" },
      { authorization: "Bearer wrong" },
      { authorization: "", cookie },
    ]) {
      await compare({ status: 403, error: "evidence_forbidden", headers });
    }
    await compare({ status: 403, error: "evidence_forbidden", url: `${path}0` });
    await compare({ status: 403, error: "evidence_forbidden", profile: "expired" });
    await compare({ status: 422, error: "invalid_failure_id", url: `${path}?override=1` });
    await compare({
      status: 422,
      error: "invalid_failure_id",
      url: `/admin/queue/source-evidence/0${id}`,
    });
    await compare({
      status: 422,
      error: "invalid_failure_id",
      url: `/admin/queue/source-evidence/%30${id}`,
      exact: false,
    });
    for (const suffix of ["/", "/__data.json"]) {
      await compare({
        status: 404,
        error: "preview_disabled",
        url: `${path}${suffix}`,
        exact: false,
      });
    }
    await compare({
      status: 404,
      error: "failure_not_found",
      url: "/admin/queue/source-evidence/9007199254740991",
      profile: "missing",
    });
    await compare({ status: 503, error: "evidence_unavailable", profile: "unavailable" });
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      await compare({
        status: 405,
        error: "method_not_allowed",
        method,
        body: "small upload",
        profile: "disabled",
      });
    }
    await compare({
      status: 403,
      error: "cross_origin",
      method: "POST",
      headers: { accept: "application/json", origin: "https://example.invalid" },
      body: "x".repeat(5 * 1024),
    });
    await compare({
      status: 413,
      method: "POST",
      headers: { accept: "application/json" },
      body: "x".repeat(5 * 1024),
    });
    assert.deepEqual(await Promise.all([fixtureRows(), fixtureSessions(), readAudits()]), before);
    console.log(
      "PASS installed source-evidence Hono fallback and Kit bearer, response, and read-only parity",
    );
  } finally {
    try {
      await sql`delete from queue_failed_jobs where job_id = ${job}`;
      await sql`delete from web_sessions where user_id = ${moderator}`;
      assert.equal((await fixtureRows()).length, 0, "synthetic failure row removed");
      assert.equal((await fixtureSessions()).length, 0, "synthetic moderator session removed");
      console.log("PASS synthetic source-evidence incident and moderator session removed");
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}
