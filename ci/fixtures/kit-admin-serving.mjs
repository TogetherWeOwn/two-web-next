import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";

const editor = "/admin/events/new";
const operator = "/admin/ops-overrides";
const html = { accept: "text/html" };
const unpublishFallback = "x-fixture-featured-unpublish-fallback";

export async function prepareAdminFixture(worker, entry) {
  const bot = "https://fixture-operator-bot.invalid";
  await writeFile(
    entry,
    `
import worker from ${JSON.stringify(worker)};
import { env, withEnv } from "cloudflare:workers";
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
export default {
  ...worker,
  fetch(request, bindings, context) {
    if (request.headers.get(${JSON.stringify(unpublishFallback)}) !== "true") {
      return worker.fetch(request, bindings, context);
    }
    const fallback = { ...bindings, KIT_PARITY_FIXTURE_ADMIN_FEATURED_UNPUBLISH: "false" };
    return withEnv(fallback, () => worker.fetch(request, fallback, context));
  },
};
`,
  );
  return {
    KIT_ROUTE_ADMIN: "true",
    KIT_PARITY_FIXTURE_ADMIN_DASHBOARD: "true",
    KIT_PARITY_FIXTURE_ADMIN_FEATURED_UNPUBLISH: "true",
    BOT_ENDPOINT_URL: bot,
    OPS_CONTROL_TOKEN: FIXTURE_SECRETS.OPS_CONTROL_TOKEN,
  };
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

export async function assertFeaturedUnpublishParity({ kit, off, hono, databaseUrl }) {
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const memberId = String(actor + 1n);
  const ip = "192.0.2.188";
  const title = `Fixture featured withdrawal ${moderatorId}`;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const moderator = await session(sql, moderatorId, true);
    const member = await session(sql, memberId, false);
    const [{ id: kitId }, { id: fallbackId }, { id: honoId }] = await sql`
      insert into featured_contents (title, is_published, created_by, updated_at)
      values (${title}, true, ${moderatorId}, '2020-01-01'),
             (${title}, true, ${moderatorId}, '2020-01-01'),
             (${title}, true, ${moderatorId}, '2020-01-01') returning id
    `;
    const featureOff = {
      ...kit,
      name: "installed Kit with unpublish ownership off",
      headers: { ...kit.headers, [unpublishFallback]: "true" },
    };
    const listPath = "/admin/featured";
    const action = (id) => `${listPath}/${id}/unpublish`;
    // Keep the Admin pages on Kit while turning off only the unpublish POST.
    const list = await visit(featureOff, `${listPath}?q=${encodeURIComponent(title)}`, 200, {
      headers: { ...html, cookie: moderator },
    });
    assert.ok(list.text.includes(`method="post" action="${action(kitId)}"`));
    assert.ok(list.text.includes(`method="post" action="${action(fallbackId)}"`));
    const cookie = renewedModerator(list.headers);
    const form = {
      method: "POST",
      headers: { ...html, cookie, "cf-connecting-ip": ip, "x-forwarded-for": ip },
      body: new URLSearchParams(),
    };

    async function snapshot(id) {
      const [row] = await sql`
        select title, is_published, updated_at::text from featured_contents where id = ${id}
      `;
      const receipts = await sql`
        select id, causer_id, description, properties from activity_log
        where subject_type = 'FeaturedContent' and subject_id = ${String(id)} order by id
      `;
      return { row, receipts: [...receipts] };
    }

    for (const [target, id] of [
      [kit, kitId],
      [featureOff, fallbackId],
      [hono, honoId],
    ]) {
      const owned = target === kit;
      const path = action(id);
      const before = await snapshot(id);
      assert.equal(before.row.is_published, true);
      assert.deepEqual(before.receipts, []);
      const denied = await visit(target, path, 403, {
        ...form,
        owned,
        headers: { ...html, cookie: member },
      });
      assert.match(denied.text, /You do not have access to this/);
      assert.equal(denied.headers.getSetCookie().length, 0);
      const guest = await visit(target, path, 303, {
        ...form,
        owned,
        headers: { ...html, referer: `${target.origin}${listPath}` },
      });
      assert.equal(guest.headers.get("location"), "/auth/recover?next=%2Fadmin%2Ffeatured");
      assert.equal(guest.headers.getSetCookie().length, 1);
      const wrongMethod = await visit(target, path, 404, {
        method: "PUT",
        owned: false,
        headers: form.headers,
      });
      assert.equal(wrongMethod.headers.get("location"), null);
      await visit(target, path, 403, {
        ...form,
        owned,
        headers: { ...form.headers, origin: "https://fixture-cross-origin.invalid" },
      });
      await visit(target, path, 413, { ...form, owned, body: "x".repeat(4097) });
      assert.deepEqual(
        await snapshot(id),
        before,
        "refused requests leave the row and audit untouched",
      );

      const saved = await visit(target, path, 303, { ...form, owned });
      assert.equal(saved.headers.get("location"), listPath);
      assert.equal(saved.headers.getSetCookie().length, 0);
      const after = await snapshot(id);
      assert.equal(after.row.title, title);
      assert.equal(after.row.is_published, false);
      assert.notEqual(after.row.updated_at, before.row.updated_at);
      assert.deepEqual(
        after.receipts.map(({ id: _id, ...receipt }) => receipt),
        [
          {
            causer_id: moderatorId,
            description: `unpublished featured content ${title}`,
            properties: { isPublished: { before: true, after: false } },
          },
        ],
      );
      const repeated = await visit(target, path, 303, { ...form, owned });
      assert.equal(repeated.headers.get("location"), listPath);
      assert.deepEqual(
        await snapshot(id),
        after,
        "stale replay leaves the saved version and audit intact",
      );
    }

    const committed = await snapshot(kitId);
    const fallback = await visit(off, action(kitId), 303, { ...form, owned: false });
    assert.equal(fallback.headers.get("location"), listPath);
    assert.deepEqual(
      await snapshot(kitId),
      committed,
      "Hono fallback preserves the Kit mutation and audit",
    );

    await sql`delete from featured_contents where id = ${honoId} and created_by = ${moderatorId}`;
    const missing = await snapshot(honoId);
    assert.equal(missing.row, undefined);
    for (const target of [kit, featureOff, off, hono]) {
      const refused = await visit(target, action(honoId), 404, { ...form, owned: target === kit });
      assert.match(refused.text, /Featured content not found/);
      assert.equal(refused.headers.get("location"), null);
    }
    assert.deepEqual(await snapshot(honoId), missing, "missing target cannot add an audit row");
  } finally {
    try {
      // Audit rows are append-only. The hosted job discards the disposable database.
      await sql`delete from featured_contents where created_by = ${moderatorId}`;
      await sql`delete from web_sessions where user_id in (${moderatorId}, ${memberId})`;
      await sql`delete from web_throttle_hits where bucket = ${`admin-write:${ip}`}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed Worker featured unpublish admission, write audit, replay, and Hono fallback",
  );
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
    // form and the exact legacy alias, which must win even with Kit admin on.
    for (const [target, cookie] of [
      [kit, moderator],
      [hono, await session(sql, moderatorId, true)],
    ]) {
      const owned = target === kit;
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
      const legacy = await visit(target, "/admin/events/create?ignored=1", 301, {
        owned: false,
        headers: { cookie: renewedModerator(existing.headers) },
      });
      assert.equal(legacy.headers.get("location"), editor);
    }
    console.log("PASS installed Worker admin event route precedence and moderator admission");
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
