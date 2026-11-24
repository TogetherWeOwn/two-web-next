import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const editor = "/admin/events/new";
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

function renewedModerator(headers) {
  const cookie = headers.getSetCookie().find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie, "Kit refreshes the shared moderator bearer");
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

async function visit(worker, path, status, { method = "GET", headers, body, owned = true } = {}) {
  const label = `${worker.name} ${method} ${path}`;
  const response = await fetch(`${worker.origin}${path}`, {
    method,
    redirect: "manual",
    headers: { origin: worker.origin, ...headers },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, label);
  assert.equal(response.headers.get("x-two-renderer"), owned ? "kit" : null, label);
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/, label);
  assert.ok(response.headers.get("x-request-id"), label);
  assert.match(response.headers.get("content-security-policy") ?? "", /form-action 'self'/, label);
  if (method === "HEAD") assert.equal(text.length, 0, label);
  return { headers: response.headers, text };
}

export async function assertStagedAdminServing({ origin, owner, secrets, enabled }) {
  const worker = { name: "isolated admin cutover", origin };
  if (!enabled) {
    await visit(worker, editor, 302, { owned: false });
    await visit(worker, operator, 404, { owned: false });
    return;
  }

  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderator = await session(owner, String(actor), true, secrets.SESSION_SECRET);
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
  const edit = await visit(worker, editor, 200, { headers: { cookie: moderator, ...html } });
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

export async function assertKitAdminServing({ kit, off, hono, databaseUrl }) {
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
    const evidence = await visit(kit, evidencePath, 404, { owned: false, headers: operatorAuth });
    assert.deepEqual(JSON.parse(evidence.text), { error: "evidence_disabled" });
    const evidenceWrite = await visit(kit, evidencePath, 405, {
      method: "POST",
      owned: false,
      headers: { cookie: moderator },
    });
    assert.equal(evidenceWrite.headers.get("allow"), "GET");
    for (const path of ["/admin", editor, "/admin/no-such-page", "/admin/events/create"]) {
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
    await visit(kit, `${featuredPath}/delete`, 303, { ...form, body: new URLSearchParams() });
    const [{ count: events }] =
      await sql`select count(*)::int from events where created_by = ${moderatorId}`;
    const [{ count: writes }] =
      await sql`select count(*)::int from activity_log where causer_id = ${moderatorId}`;
    assert.equal(events, 2, "event create and duplicate each persist once");
    assert.equal(writes, 5, "five accepted actions each audit once; refusals do not write");

    const doc = await visit(kit, editor, 200, { headers: { cookie: moderator } });
    assert.match(doc.text, /<form[^>]+method="post"[^>]+action="\/admin\/events"/);
    moderator = renewedModerator(doc.headers);
    const legacy = await visit(kit, "/admin/events/create?ignored=1", 301, {
      owned: false,
      headers: { cookie: moderator },
    });
    assert.equal(legacy.headers.get("location"), editor);
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
