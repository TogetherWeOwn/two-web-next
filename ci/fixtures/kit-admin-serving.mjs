import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { newEventKey } from "../../src/admin/validation-event-keys.ts";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { STAGING_ORIGIN } from "../operator-constants.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const editor = "/admin/events/new";
const legacyCreate = "/admin/events/create";
const operator = "/admin/ops-overrides";
const html = { accept: "text/html" };

export async function prepareAdminFixture(worker, entry) {
  const bot = "https://fixture-operator-bot.invalid";
  await writeFile(
    entry,
    `
import worker from ${JSON.stringify(worker)};
import { env } from "cloudflare:workers";
const transport = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (input !== ${JSON.stringify(`${bot}/ops/config`)}) return transport(input, init);
  if (init?.method !== "GET" || init.redirect !== "manual" ||
      new Headers(init.headers).get("authorization") !== "Bearer " + env.OPS_CONTROL_TOKEN) {
    return new Response(null, { status: 403 });
  }
  return Response.json({ epoch: 42, overrides: { label: "Fixture operator value" },
    baseline: {}, enforcement: "fixture" });
};
export default worker;
`,
  );
  return {
    KIT_ROUTE_ADMIN: "true",
    KIT_PARITY_FIXTURE_ADMIN_DASHBOARD: "true",
    BOT_ENDPOINT_URL: bot,
    OPS_CONTROL_TOKEN: FIXTURE_SECRETS.OPS_CONTROL_TOKEN,
  };
}

export async function prepareAdminPublishFixture(worker, entry) {
  const postgresEntry = fileURLToPath(import.meta.resolve("postgres"));
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import postgres from ${JSON.stringify(postgresEntry)};
import inner from ${JSON.stringify(worker)};

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const key = path.split("/")[3];
    if (request.method !== "POST" || path !== "/admin/events/" + key + "/publish") {
      return inner.fetch(request, env, ctx);
    }
    // The Workers share Postgres throttle counters. Use a fixture client
    // distinct from the other admin cases and keep the real throttle in place.
    const input = new Request(request);
    input.headers.set("cf-connecting-ip", "192.0.2.198");
    const attempts = [];
    const bindings = { ...env, SYNC_EVENT_QUEUE: {
      async send(message, options) {
        const receipt = { message, delay: options?.delaySeconds, committed: false };
        attempts.push(receipt);
        // A separate connection sees only committed event and audit rows.
        const sql = postgres(env.DATABASE_URL, { max: 1 });
        try {
          const [row] = await sql\`
            select status, (select count(*)::int from activity_log
              where subject_type = 'Event' and subject_id = \${key}) as audits
            from events where event_key = \${key}
          \`;
          receipt.committed = row?.status === "published" && row.audits === 1;
        } finally {
          await sql.end({ timeout: 1 });
        }
      },
    }};
    const response = await withEnv(bindings, () => inner.fetch(input, bindings, ctx));
    const headers = new Headers(response.headers);
    headers.set("x-fixture-publish-queue", JSON.stringify(attempts));
    return new Response(response.body, { status: response.status, headers });
  },
};\n`,
  );
  return entry;
}

function renewedModerator(headers) {
  const cookie = headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie, "the response refreshes the shared moderator bearer");
  return cookie.split(";", 1)[0];
}

async function session(sql, userId, moderator, secret = FIXTURE_SECRETS.SESSION_SECRET) {
  const token = `two_${randomBytes(32).toString("base64url")}`;
  const hash = createHash("sha256").update(token).digest("hex");
  await sql`
    insert into web_sessions
      (token_hash, status_hash, user_id, username, member, moderator, expires_at, roles_checked_at)
    values (${hash}, ${hash}, ${userId}, 'Fixture admin serving', true, ${moderator},
      now() + interval '1 hour', now())
  `;
  const cookie = await generateSignedCookie(SESSION_COOKIE, token, secret, {
    path: "/",
    secure: true,
  });
  return cookie.split(";", 1)[0];
}

async function visit(
  worker,
  path,
  status,
  { method = "GET", headers, body, owned = true, noStore = true } = {},
) {
  const label = `${worker.name} ${method} ${path.split("?")[0]}`;
  const response = await fetch(`${worker.origin}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: worker.origin, ...worker.headers, ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("x-two-renderer"), owned ? "kit" : null, label);
  if (noStore) assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, label);
  assert.ok(response.headers.get("x-request-id"), label);
  assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'self'/, label);
  if (method === "HEAD") assert.equal(text.length, 0, label);
  return { headers: response.headers, text };
}

async function prepareQueuePreviewFixture(worker, entry, operatorId) {
  // The TCP connection stays on loopback. Both Workers see the canonical URL
  // and explicit Origin required by the real queue gate, with synthetic bindings.
  await writeFile(
    entry,
    `
import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};
const profiles = {
  unset: { KIT_ROUTE_ADMIN: "true" },
  off: { KIT_ROUTE_ADMIN: "true", KIT_ROUTE_ADMIN_QUEUE_PREVIEW: "false" },
  on: { KIT_ROUTE_ADMIN_QUEUE_PREVIEW: "true" },
  disabled: { KIT_ROUTE_ADMIN_QUEUE_PREVIEW: "true", QUEUE_RECONCILE_PREVIEW_ENABLED: "false" },
};
let unexpectedHttp = false;
globalThis.fetch = async () => {
  unexpectedHttp = true;
  throw new Error("Unexpected outbound queue preview fixture request");
};
export default {
  async fetch(incoming, env, context) {
    const local = new URL(incoming.url);
    if (local.pathname === "/favicon.ico") return worker.fetch(incoming, env, context);
    const profile = incoming.headers.get("x-fixture-preview-profile");
    if (!Object.hasOwn(profiles, profile)) return new Response(null, { status: 400 });
    const bindings = {
      ...env, APP_URL: ${JSON.stringify(STAGING_ORIGIN)}, KIT_ROUTE_ADMIN: "false",
      QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
      QUEUE_RECONCILE_OPERATOR_ID: ${JSON.stringify(operatorId)}, ...profiles[profile],
    };
    const url = new URL(bindings.APP_URL);
    url.pathname = local.pathname;
    url.search = local.search;
    const request = new Request(url, incoming);
    request.headers.delete("x-fixture-preview-profile");
    request.headers.set("host", url.host);
    const origin = request.headers.get("origin");
    if (origin === local.origin) request.headers.set("origin", url.origin);
    else if (origin === "") request.headers.delete("origin");
    const response = await withEnv(bindings, () => worker.fetch(request, bindings, context));
    if (unexpectedHttp) throw new Error("Queue preview fixture attempted outbound HTTP");
    return response;
  },
};\n`,
  );
}

export async function assertKitQueuePreviewServing({
  worker,
  honoWorker,
  scratch,
  databaseUrl,
  start,
}) {
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const operatorId = String(actor);
  const otherModerator = String(actor + 1n);
  const member = String(actor + 2n);
  const jobId = randomUUID();
  const sourceKey = `sync-event:01${randomBytes(12).toString("hex").toUpperCase()}`;
  const sql = postgres(databaseUrl, { max: 1 });
  const requestId = "0123456789abcdef";
  const contractHeaders = [
    "cache-control",
    "content-type",
    "location",
    "vary",
    "etag",
    "allow",
    "content-security-policy",
    "x-frame-options",
    "x-robots-tag",
    "referrer-policy",
  ];
  function contract(result) {
    return contractHeaders.map((name) => result.headers.get(name));
  }

  try {
    const [failure] = await sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${jobId}, 'sync-event', ${sourceKey}, 'synthetic private diagnostics')
      returning id::text, failed_at`;
    const failureId = failure.id;
    const path = `/admin/queue/failed/${failureId}/preview`;
    const targets = {};
    for (const [name, entrypoint] of [
      ["hono", honoWorker],
      ["kit", worker],
    ]) {
      const entry = join(scratch, `queue-preview-${name}.mjs`);
      await prepareQueuePreviewFixture(entrypoint, entry, operatorId);
      targets[name] = await start(name, entry);
    }
    async function read(
      target,
      profile,
      status,
      { url = path, actor, method, origin, accept = "application/json", owned = false } = {},
    ) {
      const cookie = actor ? await session(sql, actor, actor !== member) : undefined;
      const response = await visit(target, url, status, {
        method,
        owned,
        headers: {
          accept,
          "cf-ray": requestId,
          "if-none-match": "*",
          "x-fixture-preview-profile": profile,
          ...(cookie ? { cookie } : {}),
          ...(origin === undefined ? {} : { origin }),
        },
      });
      assert.equal(response.headers.get("x-request-id"), requestId);
      assert.equal(response.headers.get("etag"), null);
      return { ...response, cookie };
    }
    async function compareRefusal(profile, status, options, error, cookies = "none") {
      const baseline = await read(targets.hono, profile, status, options);
      const candidate = await read(targets.kit, profile, status, { ...options, owned: true });
      assert.deepEqual(contract(candidate), contract(baseline));
      assert.equal(candidate.text, baseline.text);
      if (error) assert.deepEqual(JSON.parse(candidate.text), { error });
      for (const result of [baseline, candidate]) {
        assert.equal(result.headers.getSetCookie().length, cookies === "none" ? 0 : 1);
        if (cookies === "renewed") assertRenewed(result);
      }
      if (cookies === "intended") {
        assert.equal(candidate.headers.get("location"), "/auth/discord");
        assert.ok(candidate.headers.getSetCookie()[0].startsWith("__Host-two_login_intended="));
        assert.ok(candidate.headers.getSetCookie()[0] === baseline.headers.getSetCookie()[0]);
      }
    }
    function assertRenewed(result) {
      assert.ok(renewedModerator(result.headers) !== result.cookie);
      const attributes = result.headers.getSetCookie()[0].split(";").slice(1);
      assert.deepEqual(attributes, [
        " Max-Age=7200",
        " Path=/",
        " HttpOnly",
        " Secure",
        " SameSite=Lax",
      ]);
    }
    const receipts =
      () => sql`select log_name, description, causer_type, causer_id, event, properties
      from activity_log where subject_type = 'queue_failed_jobs' and subject_id = ${failureId} order by id`;

    await compareRefusal("disabled", 404, { actor: operatorId }, "preview_disabled");
    await compareRefusal("on", 403, { actor: operatorId, origin: "" }, "cross_origin");
    await compareRefusal("on", 302, {}, undefined, "intended");
    await compareRefusal("on", 403, { actor: member });
    await compareRefusal("on", 403, { actor: member, accept: "text/html" });
    await compareRefusal("on", 403, { actor: otherModerator }, "operator_required", "renewed");
    await compareRefusal(
      "on",
      422,
      { actor: operatorId, url: `${path}?extra=1` },
      "invalid_failure_id",
      "renewed",
    );
    await compareRefusal(
      "on",
      422,
      { actor: operatorId, url: path.replace(`/${failureId}/`, `/0${failureId}/`) },
      "invalid_failure_id",
      "renewed",
    );
    await compareRefusal(
      "on",
      404,
      { actor: operatorId, url: path.replace(`/${failureId}/`, "/9007199254740991/") },
      "failure_not_found",
      "renewed",
    );
    assert.equal((await receipts()).length, 0, "refusals leave no operational receipt");
    console.log("PASS installed Kit queue preview admission, refusal and cache match direct Hono");

    const encodedId = `%${failureId.charCodeAt(0).toString(16)}${failureId.slice(1)}`;
    for (const [method, url] of [
      ["HEAD", path],
      ["POST", path],
      ["OPTIONS", path],
      ["GET", `${path}/`],
      ["GET", `${path}/__data.json`],
      ["GET", path.replace("/failed/", "/%66ailed/")],
      ["GET", path.replace(`/${failureId}/`, `/${encodedId}/`)],
      ["GET", path.replace(`/${failureId}/`, `/${failureId}%2F1/`)],
      ["GET", path.replace(`/${failureId}/`, `/${failureId}/1/`)],
    ]) {
      const options = { url, method };
      const baseline = await read(targets.hono, "disabled", 404, options);
      const fallback = await read(targets.kit, "disabled", 404, options);
      assert.deepEqual(contract(fallback), contract(baseline));
      assert.equal(fallback.text, baseline.text);
    }

    let baselineHeaders;
    let expectedReceipts = 0;
    for (const [name, profile, owned] of [
      ["hono", "on", false],
      ["kit", "unset", false],
      ["kit", "off", false],
      ["kit", "on", true],
    ]) {
      const result = await read(targets[name], profile, 200, { actor: operatorId, owned });
      baselineHeaders ??= contract(result);
      assert.deepEqual(contract(result), baselineHeaders);
      assert.equal(result.headers.get("cache-control"), "private, no-store");
      assert.equal(result.headers.getSetCookie().length, 1);
      assertRenewed(result);
      const body = JSON.parse(result.text);
      assert.equal(new Date(body.observedAt).toISOString(), body.observedAt);
      assert.deepEqual(body, {
        previewOnly: true,
        failure: {
          id: Number(failureId),
          kind: "sync-event",
          failedAt: failure.failed_at.toISOString(),
        },
        observedAt: body.observedAt,
        disposition: {
          action: "keep",
          reason: "source is missing; preserve dead row for operator review",
        },
      });
      const logged = await receipts();
      assert.equal(
        logged.length,
        ++expectedReceipts,
        "exactly one operational receipt per success",
      );
      assert.deepEqual(logged.at(-1), {
        log_name: "operations",
        description: "queue.failed.preview",
        causer_type: "User",
        causer_id: operatorId,
        event: "view",
        properties: {
          disposition: { before: null, after: "keep" },
          observedAt: { before: null, after: body.observedAt },
        },
      });
    }
    // This job owns the disposable DB. Reject only new operational preview
    // receipts during these two requests, then restore the fixture schema.
    await sql`alter table activity_log add constraint fixture_queue_preview_audit_failure
      check (description is distinct from 'queue.failed.preview') not valid`;
    try {
      await compareRefusal("on", 503, { actor: operatorId }, "preview_unavailable", "renewed");
    } finally {
      await sql`alter table activity_log drop constraint fixture_queue_preview_audit_failure`;
    }
    assert.equal((await receipts()).length, expectedReceipts);
    const [retained] = await sql`select id::text, kind, key, reason, failed_at
      from queue_failed_jobs where job_id = ${jobId}`;
    assert.deepEqual(retained, {
      ...failure,
      kind: "sync-event",
      key: sourceKey,
      reason: "synthetic private diagnostics",
    });
    console.log(
      "PASS installed Kit queue preview owns only the exact GET, preserves Hono fallback, and refuses on audit failure",
    );
  } finally {
    try {
      // The audit table is append-only. Its synthetic receipts leave with the
      // job's disposable database, as do the other installed admin receipts.
      await sql`delete from queue_failed_jobs where job_id = ${jobId}`;
      await sql`delete from web_sessions where user_id in (${operatorId}, ${otherModerator}, ${member})`;
    } finally {
      await sql.end();
    }
  }
}

export async function assertMixedAdminAuthRollback({ worker, scratch, databaseUrl, start }) {
  // Use the isolated cutover host gate with one installed Worker and one
  // cookie jar per actor. The loopback transport never resolves this host.
  const appUrl = "https://two-web-kit-cutover-proof-174-1.fixture.workers.dev";
  const ip = "192.0.2.174";
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const memberId = String(actor + 1n);
  const stateName = "__Host-two_oauth_state";
  const intendedName = "__Host-two_login_intended";
  const statusName = "__Host-two_session_status";
  const callback = "/auth/discord/callback";
  const adminEntry = join(scratch, "kit-mixed-operator.mjs");
  const { BOT_ENDPOINT_URL, OPS_CONTROL_TOKEN } = await prepareAdminFixture(worker, adminEntry);
  const entry = join(scratch, "kit-mixed-admin-auth.mjs");
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import inner from ${JSON.stringify(adminEntry)};
const operatorFetch = globalThis.fetch;
const profiles = {
  ember: { KIT_ROUTE_ADMIN: "false", KIT_ROUTE_AUTH: "false" },
  admin: { KIT_ROUTE_ADMIN: "true", KIT_ROUTE_AUTH: "false" },
  both: { KIT_ROUTE_ADMIN: "true", KIT_ROUTE_AUTH: "true" },
};
const memberId = ${JSON.stringify(memberId)};
let exchanges = 0;
let unexpectedHttp = false;
globalThis.fetch = async (input, init) => {
  if (input === ${JSON.stringify(`${BOT_ENDPOINT_URL}/ops/config`)}) return operatorFetch(input, init);
  const url = new URL(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  if (url.origin === "https://discord.com") {
    if (url.pathname === "/api/v10/oauth2/token" && method === "POST" &&
        new URLSearchParams(init.body).get("code") === "fixture-code") {
      exchanges++;
      return Response.json({ access_token: "fixture-mixed-access" });
    }
    if (url.pathname === "/api/v10/users/@me" && method === "GET") {
      return Response.json({
        id: memberId, username: "Synthetic mixed member", global_name: null, avatar: null,
      });
    }
    if (url.pathname.endsWith("/members/" + memberId) && method === "PUT") {
      return new Response(null, { status: 204 });
    }
  }
  unexpectedHttp = true;
  throw new Error("Unexpected outbound mixed cutover fixture request");
};
export default {
  async fetch(incoming, env, context) {
    const original = new URL(incoming.url);
    if (original.pathname === "/favicon.ico") return inner.fetch(incoming, env, context);
    const profile = incoming.headers.get("x-fixture-mixed-profile");
    if (!Object.hasOwn(profiles, profile)) return new Response(null, { status: 400 });
    const bindings = { ...env, ...profiles[profile], APP_URL: ${JSON.stringify(appUrl)} };
    const url = new URL(bindings.APP_URL);
    url.pathname = original.pathname;
    url.search = original.search;
    const request = new Request(url, incoming);
    request.headers.delete("x-fixture-mixed-profile");
    request.headers.set("host", url.host);
    request.headers.set("cf-connecting-ip", ${JSON.stringify(ip)});
    if (request.headers.get("origin") === original.origin) request.headers.set("origin", url.origin);
    const response = await withEnv(bindings, () => inner.fetch(request, bindings, context));
    if (unexpectedHttp) throw new Error("Mixed cutover fixture attempted unexpected outbound HTTP");
    const headers = new Headers(response.headers);
    headers.set("x-fixture-exchanges", String(exchanges));
    return new Response(response.body, { status: response.status, headers });
  },
};\n`,
  );
  const origin = await start(entry, {
    ...EMBER_CUTOVER_VARS,
    BOT_ENDPOINT_URL,
    OPS_CONTROL_TOKEN,
  });
  const adminForm = { method: "POST", body: new URLSearchParams() };
  const operatorAuth = { authorization: `Bearer ${OPS_CONTROL_TOKEN}` };
  const sql = postgres(databaseUrl, { max: 1 });
  let moderator;
  let stateHash;
  let visitPhase;

  function readCookie(headers, name, age) {
    const lines = headers.getSetCookie().filter((line) => line.startsWith(`${name}=`));
    assert.equal(lines.length, 1, `one ${name} cookie`);
    assert.ok(lines[0].endsWith(`; Max-Age=${age}; Path=/; HttpOnly; Secure; SameSite=Lax`), name);
    return lines[0].split(";", 1)[0];
  }

  async function status(headers, authenticated, owned) {
    const result = await visitPhase("/auth/status", 200, { headers, owned });
    assert.equal(result.headers.get("vary"), "Cookie");
    assert.equal(result.headers.getSetCookie().length, 0);
    assert.deepEqual(JSON.parse(result.text), { authenticated });
  }

  async function enter(name, profile, admin, auth) {
    visitPhase = visit.bind(null, {
      name,
      origin,
      headers: { "x-fixture-mixed-profile": profile },
    });
    const edit = await visitPhase(editor, 200, {
      headers: { ...html, cookie: moderator },
      owned: admin,
    });
    assert.match(edit.text, /<form[^>]+method="post"[^>]+action="\/admin\/events"/);
    const renewed = renewedModerator(edit.headers);
    assert.ok(renewed !== moderator, "the editor rotates the existing moderator bearer");
    moderator = renewed;
    const probe = readCookie(edit.headers, statusName, 7200);
    await status({ cookie: probe }, true, auth);
    await status(operatorAuth, false, auth);

    const allowed = await visitPhase(operator, 200, { headers: operatorAuth, owned: admin });
    assert.match(allowed.text, /Fixture operator value/);
    assert.equal(allowed.headers.getSetCookie().length, 0);
    const refused = await visitPhase(operator, 401, {
      headers: { cookie: moderator },
      owned: admin,
    });
    assert.equal(refused.headers.get("www-authenticate"), "Bearer");
    assert.equal(refused.headers.getSetCookie().length, 0);
    for (const headers of [operatorAuth, { cookie: probe }]) {
      const denied = await visitPhase(editor, 302, { headers, owned: admin });
      assert.equal(denied.headers.get("location"), "/auth/discord");
    }
  }

  try {
    moderator = await session(sql, moderatorId, true);
    await enter("Ember baseline", "ember", false, false);
    await enter("Admin enabled", "admin", true, false);

    // Follow the intended-page cookie from the Kit Admin guest gate into Hono Auth.
    const guest = await visitPhase(editor, 302);
    const loginPath = guest.headers.get("location");
    assert.equal(loginPath, "/auth/discord");
    const intended = readCookie(guest.headers, intendedName, 600);
    const login = await visitPhase(loginPath, 302, {
      headers: { cookie: intended },
      owned: false,
    });
    const authorize = new URL(login.headers.get("location"));
    assert.equal(authorize.origin + authorize.pathname, "https://discord.com/oauth2/authorize");
    assert.equal(authorize.searchParams.get("redirect_uri"), appUrl + callback);
    const state = authorize.searchParams.get("state");
    assert.ok(state && /^[0-9a-f-]{36}$/.test(state), "the Hono sign-in issued a state");
    stateHash = createHash("sha256").update(state).digest("hex");
    readCookie(login.headers, stateName, 600);
    // Apply the sign-in response before simulating the browser's return.
    const jar = new Map([[intendedName, intended]]);
    for (const line of login.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(/;\s*/);
      const name = pair.slice(0, pair.indexOf("="));
      if (attributes.includes("Max-Age=0")) jar.delete(name);
      else jar.set(name, pair);
    }
    assert.equal(
      jar.has("__Host-two_login_next"),
      false,
      "login did not set an explicit next page",
    );
    const oauth = [...jar.values()].join("; ");
    const returnPath = `${callback}?${new URLSearchParams({ state, code: "fixture-code" })}`;
    console.log("PASS mixed cutover Admin enabled on Kit while Auth stays on Hono");

    await enter("Auth enabled", "both", true, true);
    const signedIn = await visitPhase(returnPath, 302, { headers: { cookie: oauth } });
    assert.equal(signedIn.headers.get("location"), editor);
    assert.equal(signedIn.headers.get("x-fixture-exchanges"), "1");
    const member = readCookie(signedIn.headers, SESSION_COOKIE, 7200);
    const memberProbe = readCookie(signedIn.headers, statusName, 7200);
    await status({ cookie: member }, true, true);
    const memberDenied = await visitPhase(editor, 403, { headers: { cookie: member } });
    assert.equal(memberDenied.headers.get("location"), null);
    await visitPhase(operator, 401, { headers: { cookie: member } });
    console.log("PASS mixed cutover Kit Auth completes Hono sign-in and Kit Admin enforces roles");

    await enter("Auth undone", "admin", true, false);
    for (const cookie of [member, memberProbe]) await status({ cookie }, true, false);
    await visitPhase(editor, 403, { headers: { cookie: member } });
    await visitPhase("/admin/events", 403, { ...adminForm, headers: { cookie: member } });
    const operatorWrite = await visitPhase("/admin/events", 303, {
      ...adminForm,
      headers: { ...html, ...operatorAuth },
    });
    assert.equal(
      operatorWrite.headers.get("location"),
      "/auth/recover?next=%2Fadmin%2Fevents%2Fnew",
    );
    assert.deepEqual(
      [
        ...(await sql`select user_id, member, moderator from web_sessions where user_id = ${memberId}`),
      ],
      [{ user_id: memberId, member: true, moderator: false }],
      "the callback issued exactly one session for the synthetic member",
    );
    const replay = await visitPhase(returnPath, 302, { headers: { cookie: oauth }, owned: false });
    assert.equal(replay.headers.get("location"), "/?n=signin_failed");
    assert.equal(replay.headers.getSetCookie().length, 0);
    assert.equal(replay.headers.get("x-fixture-exchanges"), "1");
    const logout = await visitPhase("/logout", 303, {
      method: "POST",
      headers: { cookie: member },
      body: new URLSearchParams(),
      owned: false,
      noStore: false,
    });
    assert.equal(logout.headers.get("location"), "/");
    readCookie(logout.headers, SESSION_COOKIE, 0);
    readCookie(logout.headers, statusName, 0);
    for (const cookie of [member, memberProbe]) await status({ cookie }, false, false);
    const revoked = await visitPhase(editor, 302, { headers: { cookie: member } });
    assert.equal(revoked.headers.get("location"), "/auth/discord");
    console.log(
      "PASS mixed cutover Auth undo preserves Kit Admin and revokes the Kit-issued session",
    );

    await enter("Admin undone", "ember", false, false);
    const fallback = await visitPhase(editor, 302, { headers: { cookie: member }, owned: false });
    assert.equal(fallback.headers.get("location"), "/auth/discord");
    console.log("PASS mixed cutover Admin undo restores Hono with the moderator session intact");
  } finally {
    try {
      await sql.begin(async (tx) => {
        const ids = [moderatorId, memberId];
        await tx`delete from web_session_grace where user_id in ${tx(ids)}`;
        await tx`delete from web_sessions where user_id in ${tx(ids)}`;
        await tx`delete from users where id = ${memberId}`;
        if (stateHash) await tx`delete from web_oauth_journeys where state_hash = ${stateHash}`;
        await tx`delete from web_throttle_hits where bucket in ${tx(
          ["login-redirect", "login-callback", "events-read", "logout"].map(
            (name) => `${name}:${ip}`,
          ),
        )}`;
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
}

export async function assertKitAttendanceDisabled(off, databaseUrl) {
  const moderatorId = String(900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`));
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const cookie = await session(sql, moderatorId, true);
    const { text } = await visit(off, "/admin/attendance", 404, {
      headers: { ...html, cookie },
      owned: false,
    });
    assert.match(text, /We cannot find that page/);
    assert.doesNotMatch(text, /Event attendance|Sample participant/);
  } finally {
    try {
      await sql.begin(async (tx) => {
        await tx`delete from web_session_grace where user_id = ${moderatorId}`;
        await tx`delete from web_sessions where user_id = ${moderatorId}`;
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log("PASS built Kit Worker keeps attendance disabled for a moderator by default");
}

export async function assertStagedAdminServing({ origin, owner, secrets, enabled }) {
  const worker = { name: "isolated admin cutover", origin };
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderator = await session(owner, String(actor), true, secrets.SESSION_SECRET);
  const dashboard = await visit(worker, "/admin", 200, {
    headers: { ...html, cookie: moderator },
    owned: enabled,
  });
  assert.ok(/<h1\b[^>]*>Moderation<\/h1>/.test(dashboard.text), "moderator dashboard heading");
  assert.ok(dashboard.text.includes('href="/admin/events"'), "moderator dashboard Events link");
  if (!enabled) {
    await visit(worker, editor, 302, { owned: false });
    await visit(worker, operator, 404, { owned: false });
    return;
  }

  const member = await session(owner, String(actor + 1n), false, secrets.SESSION_SECRET);
  const bearer = { authorization: `Bearer ${secrets.OPS_CONTROL_TOKEN}` };
  const reads = [
    "/admin",
    "/admin/activity-log",
    "/admin/events",
    editor,
    "/admin/events/fixture-event",
    "/admin/featured",
    "/admin/featured/new",
    "/admin/featured/1",
    "/admin/join-attempts",
    "/admin/join-attempts/1",
  ];
  for (const path of reads) {
    const denied = await visit(worker, path, 302, { headers: bearer });
    assert.equal(denied.headers.get("location"), "/auth/discord");
  }
  for (const path of ["/admin/events/create", "/admin/no-such-page"]) {
    await visit(worker, path, 302, { owned: false, headers: bearer });
  }
  await visit(worker, editor, 403, { headers: { cookie: member } });
  const edit = await visit(worker, editor, 200, {
    headers: { ...html, cookie: renewedModerator(dashboard.headers) },
  });
  assert.match(edit.text, /<form[^>]+method="post"[^>]+action="\/admin\/events"/);
  const renewed = renewedModerator(edit.headers);
  await visit(worker, "/admin/events", 422, {
    method: "POST",
    body: new URLSearchParams(),
    headers: { cookie: renewed, ...html },
  });
  const formDenied = await visit(worker, "/admin/events", 303, {
    method: "POST",
    body: new URLSearchParams(),
    headers: bearer,
  });
  assert.equal(formDenied.headers.get("location"), "/auth/recover?next=%2Fadmin%2Fevents%2Fnew");

  // The fixture has no bot endpoint. A valid bearer passes admission and
  // reaches the unavailable record response without any outbound call.
  for (const [method, status, headers] of [
    ["GET", 401, { cookie: renewed }],
    ["HEAD", 401, {}],
    ["GET", 503, bearer],
    ["HEAD", 503, bearer],
    ["PUT", 405, bearer],
  ]) {
    const result = await visit(worker, operator, status, { method, headers });
    assert.equal(result.headers.getSetCookie().length, 0);
    assert.equal(result.headers.get("www-authenticate"), status === 401 ? "Bearer" : null);
    if (status === 405) assert.equal(result.headers.get("allow"), "GET, HEAD");
    else assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  }
  const [{ events, featured }] = await owner`select
    (select count(*)::int from events where created_by = ${String(actor)}) as events,
    (select count(*)::int from featured_contents where created_by = ${String(actor)}) as featured`;
  assert.equal(events + featured, 0, "denied or invalid forms did not create records");
}

async function assertFeaturedAuditFallback({
  kit,
  off,
  sql,
  featuredPath,
  moderatorId,
  form,
  operatorAuth,
}) {
  const id = featuredPath.split("/").at(-1);
  const editor = await visit(kit, featuredPath, 200, { headers: form.headers });
  const moderator = { ...form.headers, cookie: renewedModerator(editor.headers) };
  const baseline = editor.text.match(/name="saved_baseline" value="([0-9a-f]{64})"/)?.[1];
  assert.ok(baseline, "Kit renders the current featured save baseline");
  const title = `Fixture fallback edit ${moderatorId}`;
  const description = `updated featured content ${title}`;
  const body = new URLSearchParams({ saved_baseline: baseline, title });

  async function snapshot() {
    const [featured] = await sql`
      select title, updated_at::text from featured_contents where id = ${id}
    `;
    const activity = await sql`
      select id, description, causer_id, created_at, properties from activity_log
      where subject_type = 'FeaturedContent' and subject_id = ${id} order by id
    `;
    return { featured, activity: [...activity] };
  }

  const before = await snapshot();
  // The same bearer has already been admitted by the Kit override adapter.
  // Submit the valid edit body with that bearer alone, then with the moderator cookie.
  const denied = await visit(kit, featuredPath, 303, {
    ...form,
    headers: { ...html, ...operatorAuth },
    body,
  });
  assert.equal(
    denied.headers.get("location"),
    `/auth/recover?next=${encodeURIComponent(featuredPath)}`,
  );
  assert.deepEqual(await snapshot(), before, "operator bearer cannot edit or append an audit row");

  const saved = await visit(kit, featuredPath, 303, { ...form, body, headers: moderator });
  assert.equal(saved.headers.get("location"), featuredPath);
  const committed = await snapshot();
  assert.equal(committed.featured.title, title);
  assert.equal(committed.activity.length, before.activity.length + 1, "one new featured audit row");
  assert.deepEqual(committed.activity.slice(0, -1), before.activity);
  const receipt = committed.activity.at(-1);
  assert.equal(receipt.causer_id, moderatorId);
  assert.equal(receipt.description, description);
  assert.deepEqual(receipt.properties.title, { before: before.featured.title, after: title });

  // The same installed output with Admin ownership off serves this through Hono.
  const activityPath = `/admin/activity-log?${new URLSearchParams({ subject: title })}`;
  const activity = await visit(off, activityPath, 200, { owned: false, headers: moderator });
  const rows = [...activity.text.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)]
    .map(([row]) => row)
    .filter((row) => row.includes(`<td>${description}</td>`));
  assert.equal(rows.length, 1, "Hono displays exactly one Kit edit audit row");
  assert.ok(rows[0].includes(`<td>${moderatorId}</td>`), "Hono displays the original causer");
  assert.ok(
    rows[0].includes(`<td>FeaturedContent ${id}</td>`),
    "Hono displays the original subject",
  );
  assert.ok(
    rows[0].includes(`datetime="${receipt.created_at.toISOString()}"`),
    "Hono displays the original audit instant",
  );
  const fallbackModerator = renewedModerator(activity.headers);

  await visit(off, featuredPath, 409, {
    ...form,
    body,
    owned: false,
    headers: { ...moderator, cookie: fallbackModerator },
  });
  assert.deepEqual(
    await snapshot(),
    committed,
    "Hono fallback preserves the edit and audit identity on replay",
  );
  console.log(
    "PASS installed Admin preserves the Kit edit and its audit record through Hono fallback",
  );
  return fallbackModerator;
}

async function assertAdminPublish({ kit, off, hono, sql, moderatorId, member }) {
  // The preceding GET checks rotate their own moderator session.
  const moderator = await session(sql, moderatorId, true);
  const keys = [];
  const title = "Synthetic publish draft";
  async function seed(location, key = newEventKey()) {
    keys.push(key);
    const [row] = await sql`
      insert into events (event_key, title, starts_at, ends_at, location, created_by)
      values (${key}, ${title}, now() + interval '1 day', now() + interval '2 days',
        ${location}, ${moderatorId})
      returning updated_at
    `;
    return { key, updatedAt: row.updated_at.toISOString(), path: `/admin/events/${key}` };
  }

  async function snapshot(key) {
    const [event] = await sql`
      select status, updated_at, sync_revision, discord_event_id from events where event_key = ${key}
    `;
    const audit = await sql`
      select description, causer_id, properties from activity_log
      where subject_type = 'Event' and subject_id = ${key} order by id
    `;
    const ledger = await sql`
      select job_id, kind from queue_jobs where key = ${`sync-event:${key}`} order by job_id
    `;
    return { event, audit: [...audit], ledger: [...ledger] };
  }

  try {
    for (const target of [kit, off, hono]) {
      const draft = await seed("Fixture meeting place");
      const blank = await seed(null);
      const reviewed = await seed("Fixture review location");
      const invalidKey = await seed("Fixture meeting place", `malformed-${newEventKey()}`);
      const owned = target === kit;
      async function post(path, status, fields, { headers, sends = 0 } = {}) {
        const response = await visit(target, `${path}/publish`, status, {
          method: "POST",
          headers: { ...html, cookie: moderator, ...headers },
          owned,
          body: new URLSearchParams(fields),
        });
        const attempts = JSON.parse(response.headers.get("x-fixture-publish-queue"));
        assert.ok(Array.isArray(attempts), `${target.name} publish queue stub ran`);
        assert.equal(attempts.length, sends, `${target.name} publish queue send count`);
        return { ...response, receipt: attempts[0] };
      }

      const before = await snapshot(draft.key);
      assert.equal(before.event.status, "draft");
      const guest = await post(draft.path, 303, {}, { headers: { cookie: "" } });
      assert.equal(
        guest.headers.get("location"),
        `/auth/recover?next=${encodeURIComponent(draft.path)}`,
      );
      assert.equal(guest.headers.getSetCookie().length, 1);
      const denied = await post(draft.path, 403, {}, { headers: { cookie: member } });
      assert.match(denied.text, /You do not have access to this/);
      assert.doesNotMatch(denied.text, /Synthetic publish draft/);
      assert.equal(denied.headers.get("location"), null);
      assert.equal(denied.headers.getSetCookie().length, 0);
      const foreign = await post(
        draft.path,
        403,
        {},
        { headers: { origin: "https://foreign.test" } },
      );
      assert.equal(foreign.headers.get("location"), null);
      assert.deepEqual(await snapshot(draft.key), before);

      const beforeMalformed = await snapshot(invalidKey.key);
      const malformed = await post(invalidKey.path, 404);
      assert.match(malformed.text, /Event not found/);
      assert.equal(malformed.headers.get("location"), null);
      assert.deepEqual(await snapshot(invalidKey.key), beforeMalformed);

      const beforeBlank = await snapshot(blank.key);
      const missingLocation = await post(blank.path, 422);
      assert.match(missingLocation.text, /Add a location before publishing\./);
      assert.ok(missingLocation.text.includes(`action="${blank.path}"`));
      assert.equal(missingLocation.headers.get("location"), null);
      assert.deepEqual(await snapshot(blank.key), beforeBlank);

      const beforeReview = await snapshot(reviewed.key);
      const publicPath = `/e/${reviewed.key}`;
      const staleRevision = new Date(Date.parse(reviewed.updatedAt) - 1_000).toISOString();
      const stale = await post(reviewed.path, 303, {
        review: "1",
        reviewed_updated_at: staleRevision,
      });
      assert.equal(stale.headers.get("location"), `${publicPath}?review=1&publish_error=stale`);
      assert.deepEqual(await snapshot(reviewed.key), beforeReview);

      for (const [record, prior, fields, location] of [
        [draft, before, {}, draft.path],
        [
          reviewed,
          beforeReview,
          { review: "1", reviewed_updated_at: reviewed.updatedAt },
          `${publicPath}?published=1`,
        ],
      ]) {
        const published = await post(record.path, 303, fields, { sends: 1 });
        assert.equal(published.headers.get("location"), location);
        const committed = await snapshot(record.key);
        assert.equal(committed.event.status, "published");
        assert.ok(committed.event.updated_at > prior.event.updated_at);
        assert.equal(BigInt(committed.event.sync_revision), BigInt(prior.event.sync_revision) + 1n);
        assert.equal(committed.event.discord_event_id, null);
        assert.deepEqual(committed.audit, [
          {
            description: `published event ${title}`,
            causer_id: moderatorId,
            properties: { status: { before: "draft", after: "published" } },
          },
        ]);
        const { message, delay, committed: visibleAtSend } = published.receipt;
        assert.equal(visibleAtSend, true, "event and audit are committed before the stub send");
        assert.equal(delay, 10);
        assert.equal(message.kind, "sync-event");
        assert.equal(message.eventKey, record.key);
        assert.equal(message.requestId, published.headers.get("x-request-id"));
        assert.match(message.idempotencyKey, /^[\da-f-]{36}$/);
        assert.deepEqual(committed.ledger, [{ kind: "sync-event", job_id: message.jobId }]);

        const refused = await post(record.path, 422);
        assert.match(refused.text, /Only a draft can be published\./);
        assert.ok(refused.text.includes(`href="${record.path}"`));
        assert.doesNotMatch(refused.text, /<form[^>]+action="[^\"]*\/publish"/);
        assert.equal(refused.headers.get("location"), null);
        assert.deepEqual(await snapshot(record.key), committed);
      }
    }
  } finally {
    if (keys.length) {
      const queueKeys = keys.map((key) => `sync-event:${key}`);
      await sql`delete from queue_jobs where key in ${sql(queueKeys)}`;
      await sql`delete from job_unique_locks where key in ${sql(queueKeys)}`;
    }
    // The caller removes these actor-owned events and sessions. Append-only
    // audit rows are discarded with the hosted disposable database.
  }
  console.log("PASS installed Worker admin publish admission, transitions, audit, and write-back");
}

export async function assertKitAdminServing({ kit, nativeCreate, off, hono, databaseUrl }) {
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const memberId = String(actor + 1n);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    let moderator = await session(sql, moderatorId, true);
    const member = await session(sql, memberId, false);
    const operatorAuth = { authorization: `Bearer ${FIXTURE_SECRETS.OPS_CONTROL_TOKEN}` };

    await visit(off, editor, 302, { owned: false });
    await visit(off, operator, 404, { owned: false });
    const evidencePath = "/admin/queue/source-evidence/1";
    // The evidence handler answers before either mounted guard. The preview
    // must instead stop at the queue guard, before the guest login redirect.
    for (const target of [hono, kit]) {
      const evidence = await visit(target, evidencePath, 404, {
        owned: false,
        headers: operatorAuth,
      });
      assert.deepEqual(JSON.parse(evidence.text), { error: "evidence_disabled" });
      const preview = await visit(target, "/admin/queue/failed/1/preview", 404, { owned: false });
      assert.deepEqual(JSON.parse(preview.text), { error: "preview_disabled" });
      for (const { headers } of [evidence, preview]) {
        assert.match(headers.get("content-type") ?? "", /^application\/json\b/);
        assert.equal(headers.get("location"), null);
        assert.equal(headers.getSetCookie().length, 0);
      }
    }
    console.log("PASS installed Worker preserves Hono queue guard and evidence-handler order");
    const evidenceWrite = await visit(kit, evidencePath, 405, {
      method: "POST",
      owned: false,
      headers: { cookie: moderator },
    });
    assert.equal(evidenceWrite.headers.get("allow"), "GET");
    for (const path of ["/admin", editor, "/admin/no-such-page", legacyCreate]) {
      const owned = path === "/admin" || path === editor;
      const guest = await visit(kit, path, 302, { owned });
      assert.equal(guest.headers.get("location"), "/auth/discord");
      assert.equal(guest.headers.getSetCookie().length, 1, "one intended-page cookie");
    }
    const reconciliation = await visit(kit, "/admin/reconciliation", 302);
    assert.equal(
      reconciliation.headers.get("location"),
      "/auth/discord?next=%2Fadmin%2Freconciliation",
    );
    await visit(kit, editor, 403, { headers: { ...html, cookie: member } });
    await visit(kit, editor, 200, { method: "HEAD", headers: { cookie: moderator } });

    const refused = await visit(kit, operator, 401, { headers: { cookie: moderator } });
    assert.equal(refused.headers.get("www-authenticate"), "Bearer");
    assert.equal(refused.headers.getSetCookie().length, 0);
    assert.equal(refused.headers.get("referrer-policy"), "no-referrer");
    const head = await visit(kit, operator, 401, { method: "HEAD" });
    assert.equal(head.headers.get("www-authenticate"), "Bearer");
    const admitted = await visit(kit, operator, 200, { headers: operatorAuth });
    assert.match(admitted.text, /Fixture operator value/);
    assert.equal(admitted.headers.getSetCookie().length, 0);
    const allowed = await visit(kit, operator, 200, { method: "HEAD", headers: operatorAuth });
    assert.equal(allowed.headers.get("referrer-policy"), "no-referrer");
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const rejected = await visit(kit, operator, 405, { method, headers: operatorAuth });
      assert.equal(rejected.headers.get("allow"), "GET, HEAD");
      assert.deepEqual(JSON.parse(rejected.text), { error: "method_not_allowed" });
      assert.equal(rejected.headers.getSetCookie().length, 0);
    }
    await visit(kit, operator, 413, { method: "POST", body: "x".repeat(4097) });

    const form = { method: "POST", headers: { ...html, cookie: moderator } };
    const guest = await visit(kit, "/admin/events", 303, {
      method: "POST",
      headers: { ...html, ...operatorAuth },
      body: new URLSearchParams(),
    });
    assert.equal(guest.headers.get("location"), "/auth/recover?next=%2Fadmin%2Fevents%2Fnew");
    assert.equal(guest.headers.getSetCookie().length, 1, "one signed expired-write cookie");
    await visit(kit, "/admin/events", 403, {
      ...form,
      headers: { ...form.headers, origin: "https://other.example" },
      body: "x".repeat(65537),
    });
    await visit(kit, "/admin/events", 403, {
      ...form,
      headers: { ...form.headers, cookie: member },
      body: new URLSearchParams(),
    });
    await visit(kit, "/admin/events", 413, { ...form, body: "x".repeat(65537) });

    const invalid = await visit(kit, "/admin/events", 422, {
      ...form,
      body: new URLSearchParams({ description: "Keep this fixture draft" }),
    });
    assert.match(invalid.text, /Give the event a title\./);
    assert.match(invalid.text, /Keep this fixture draft/);
    const direct = await visit(hono, "/admin/events", 422, {
      ...form,
      owned: false,
      body: new URLSearchParams({ description: "Keep this fixture draft" }),
    });
    assert.match(direct.text, /Give the event a title\./);
    assert.equal(invalid.headers.get("content-type"), direct.headers.get("content-type"));

    const draft = await visit(kit, "/admin/events", 303, {
      ...form,
      body: new URLSearchParams({
        title: "Fixture admin draft",
        starts_at: "2099-10-01T12:00",
        ends_at: "2099-10-01T13:00",
        timezone: "UTC",
      }),
    });
    const eventPath = draft.headers.get("location")?.split("?")[0];
    assert.match(eventPath ?? "", /^\/admin\/events\/[0-9A-Z]{26}$/);
    const repeated = await visit(kit, `${eventPath}/duplicate`, 303, {
      ...form,
      body: new URLSearchParams(),
    });
    assert.match(repeated.headers.get("location") ?? "", /^\/admin\/events\/[0-9A-Z]{26}$/);
    assert.notEqual(repeated.headers.get("location"), eventPath);

    const saved = await visit(kit, "/admin/featured", 303, {
      ...form,
      body: new URLSearchParams({ title: "Fixture admin feature" }),
    });
    const featuredPath = saved.headers.get("location");
    assert.match(featuredPath ?? "", /^\/admin\/featured\/\d+$/);
    const edit = await visit(kit, featuredPath, 200, { headers: { cookie: moderator } });
    moderator = renewedModerator(edit.headers);
    form.headers.cookie = moderator;
    const baseline = edit.text.match(/name="saved_baseline" value="([0-9a-f]{64})"/)?.[1];
    assert.ok(baseline, "Kit renders the saved version in the native form");
    await visit(hono, featuredPath, 303, {
      ...form,
      owned: false,
      body: new URLSearchParams({ saved_baseline: baseline, title: "Competing fixture edit" }),
    });
    const stale = await visit(kit, featuredPath, 409, {
      ...form,
      body: new URLSearchParams({ saved_baseline: baseline, title: "Keep this unsaved headline" }),
    });
    assert.match(stale.text, /Keep this unsaved headline/);
    assert.equal(stale.headers.getSetCookie().length, 0);
    const [{ title }] =
      await sql`select title from featured_contents where created_by = ${moderatorId}`;
    assert.equal(title, "Competing fixture edit");
    moderator = await assertFeaturedAuditFallback({
      kit,
      off,
      sql,
      featuredPath,
      moderatorId,
      form,
      operatorAuth,
    });
    form.headers.cookie = moderator;
    await visit(kit, `${featuredPath}/delete`, 303, { ...form, body: new URLSearchParams() });
    const [{ count: events }] =
      await sql`select count(*)::int from events where created_by = ${moderatorId}`;
    const [{ count: writes }] =
      await sql`select count(*)::int from activity_log where causer_id = ${moderatorId}`;
    assert.equal(events, 2, "event create and duplicate each persist once");
    assert.equal(writes, 6, "six accepted actions each audit once; refusals do not write");

    // A seeded key makes the parameter route observable next to the static
    // form and exact alias. Both installed modes keep the other forms in Kit.
    for (const target of [kit, nativeCreate, hono]) {
      const owned = target !== hono;
      const cookie = target === kit ? moderator : await session(sql, moderatorId, true);
      const denied = await visit(target, eventPath, 403, {
        owned,
        headers: { ...html, cookie: member },
      });
      assert.match(denied.text, /You do not have access to this/);
      assert.doesNotMatch(denied.text, /Fixture admin draft|data-event-editor/);
      assert.equal(denied.headers.getSetCookie().length, 0);

      const doc = await visit(target, editor, 200, { owned, headers: { ...html, cookie } });
      assert.match(doc.text, /<form[^>]+method="post"[^>]+action="\/admin\/events"/);
      const existing = await visit(target, eventPath, 200, {
        owned,
        headers: { ...html, cookie: renewedModerator(doc.headers) },
      });
      assert.match(existing.text, /<h1[^>]*>Edit Fixture admin draft<\/h1>/);
      assert.ok(existing.text.includes(`action="${eventPath}"`));
      const current = renewedModerator(existing.headers);
      const ownedRedirect = target === nativeCreate;
      const alias = `${legacyCreate}?ignored=1&next=%2Felsewhere`;
      const login = await visit(target, alias, 302, { owned: ownedRedirect });
      assert.equal(login.headers.get("location"), "/auth/discord");
      assert.ok(
        login.headers
          .getSetCookie()[0]
          ?.startsWith(`__Host-two_login_intended=${encodeURIComponent(alias)}.`),
        "the login cookie preserves the requested path and query",
      );
      const refusal = await visit(target, alias, 403, {
        owned: ownedRedirect,
        headers: { ...html, cookie: member },
      });
      assert.equal(refusal.headers.get("location"), null);
      assert.equal(refusal.headers.getSetCookie().length, 0);
      const head = await visit(target, alias, 301, {
        method: "HEAD",
        owned: ownedRedirect,
        headers: { ...html, cookie: current },
      });
      assert.equal(head.headers.get("location"), editor);
      assert.equal(head.headers.getSetCookie().length, 0);
      const legacy = await visit(target, alias, 301, {
        owned: ownedRedirect,
        headers: { ...html, cookie: current },
      });
      assert.equal(legacy.text, "");
      assert.equal(legacy.headers.get("location"), editor);
      assert.match(legacy.headers.get("content-type") ?? "", /^text\/plain\b/);
      const renewed = renewedModerator(legacy.headers);
      const legacyEdit = await visit(target, `${eventPath}/edit?ignored=1`, 301, {
        owned: false,
        headers: { cookie: renewed },
      });
      assert.equal(legacyEdit.headers.get("location"), eventPath);
      await visit(target, legacyCreate, 413, {
        ...form,
        owned,
        body: "x".repeat(65537),
        headers: { ...form.headers, cookie: renewedModerator(legacyEdit.headers) },
      });
    }
    console.log("PASS installed Worker admin event route precedence and moderator admission");

    const offAlias = await visit(off, `${legacyCreate}?ignored=1`, 301, {
      owned: false,
      headers: { cookie: await session(sql, moderatorId, true) },
    });
    assert.equal(offAlias.headers.get("location"), editor);
    for (const target of [kit, nativeCreate]) {
      for (const path of [
        `${legacyCreate}/`,
        `${legacyCreate}/__data.json`,
        "/admin/events/%63reate",
        "/admin/events/cre%ZZate",
      ]) {
        const boundary = await visit(target, path, 302, { owned: false });
        assert.equal(boundary.headers.get("location"), "/auth/discord");
      }
      const parameter = await visit(target, "/admin/events/Create", 302);
      assert.equal(parameter.headers.get("location"), "/auth/discord");
    }
    console.log("PASS installed Worker legacy event-create redirect with Kit ownership off and on");

    await assertAdminPublish({ kit, off, hono, sql, moderatorId, member });
  } finally {
    try {
      // Audit rows are append-only and are isolated by the synthetic actor.
      // The hosted job discards the disposable database at teardown.
      await sql`delete from featured_contents where created_by = ${moderatorId}`;
      await sql`delete from events where created_by = ${moderatorId}`;
      await sql`delete from web_sessions where user_id in (${moderatorId}, ${memberId})`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log("PASS Kit admin ownership, isolated bearers, and native form parity");
}
