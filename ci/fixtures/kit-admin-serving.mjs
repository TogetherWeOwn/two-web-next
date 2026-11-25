import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateSignedCookie } from "hono/cookie";
import { parse } from "parse5";
import postgres from "postgres";
import { newEventKey } from "../../src/admin/validation-event-keys.ts";
import { attr, elements, submittedFields } from "../../test/helpers/kit-edit-controls.ts";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";
import { assertAdminDuplicateServing } from "./kit-admin-duplicate.mjs";

const editor = "/admin/events/new";
const legacyCreate = "/admin/events/create";
const operator = "/admin/ops-overrides";
const html = { accept: "text/html" };

export async function prepareAdminFixture(worker, entry) {
  const bot = "https://fixture-operator-bot.invalid";
  const recurringProbe = fileURLToPath(
    new URL("./kit-admin-recurring-create-worker.mjs", import.meta.url),
  );
  await writeFile(
    entry,
    `
import worker from ${JSON.stringify(worker)};
import { env } from "cloudflare:workers";
import { withRecurringCreateProbe } from ${JSON.stringify(recurringProbe)};
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
export default withRecurringCreateProbe(worker);
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

async function assertActivityLogReadParity({ kit, off, databaseUrl }) {
  const path = "/admin/activity-log";
  const pageSize = 50;
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const subject = `Fixture activity & ${moderatorId}`;
  const filters = { subject, causer: moderatorId };
  const sql = postgres(databaseUrl, { max: 1 });
  let seededIds = [];

  function row(index) {
    return {
      description: `Synthetic activity ${index}`,
      subject_type: "FixtureActivity",
      subject_id: subject,
      causer_id: moderatorId,
      created_at: new Date(Date.UTC(2000, 0, 1, 0, 0, index === 1 ? 0 : index)),
    };
  }

  async function readPage(target, href, cookie, owned, page, expectedRows) {
    const label = `${target.name} activity page ${page}`;
    const { headers, text } = await visit(target, href, 200, {
      owned,
      headers: { ...html, cookie },
    });
    const cache = headers.get("cache-control") ?? "";
    assert.deepEqual(
      cache
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .sort(),
      ["no-store", "private"],
      label,
    );
    const doc = parseRenderedPage(text);
    const table = [...renderedElements(doc, { tag: "table" })].find(
      (node) => renderedAttribute(node, "data-testid") === "activity-log-table",
    );
    assert.ok(table, `${label}: activity table`);
    const [body] = renderedElements(table, { tag: "tbody" });
    assert.ok(body, `${label}: activity rows`);
    const rows = [...renderedElements(body, { tag: "tr" })].map((entry) => {
      const cells = [...renderedElements(entry, { tag: "td" })];
      assert.equal(cells.length, 4, label);
      const [time] = renderedElements(cells[2], { tag: "time" });
      assert.ok(time, `${label}: activity instant`);
      return [
        renderedText(cells[0]).trim(),
        renderedText(cells[1]).trim(),
        renderedAttribute(time, "datetime"),
        renderedText(cells[3]).trim(),
      ];
    });
    assert.deepEqual(
      rows,
      expectedRows.map((entry) => [
        entry.causer_id,
        entry.description,
        entry.created_at.toISOString(),
        `${entry.subject_type} ${entry.subject_id}`,
      ]),
      `${label}: exactly the matching activities in newest-first order`,
    );

    const pager = [...renderedElements(doc, { tag: "nav" })].find(
      (node) => renderedAttribute(node, "aria-label") === "Activity pages",
    );
    assert.ok(pager, `${label}: activity pagination`);
    const [pageLabel] = renderedElements(pager, { tag: "span" });
    assert.ok(pageLabel, `${label}: page label`);
    assert.equal(renderedText(pageLabel).trim(), `Page ${page}`, label);
    const links = [...renderedElements(pager, { tag: "a" })];
    assert.equal(links.length, 1, `${label}: one direction is available`);
    const direction = page === 1 ? "next" : "prev";
    assert.equal(renderedAttribute(links[0], "rel"), direction, label);
    const destination = new URL(renderedAttribute(links[0], "href"), target.origin);
    assert.equal(destination.origin, target.origin, label);
    assert.equal(destination.pathname, path, label);
    assert.deepEqual(
      [...destination.searchParams].sort(),
      Object.entries({ ...filters, page: page === 1 ? "2" : "1" }).sort(),
      `${label}: ${direction} preserves both filters`,
    );
    return { href: destination.pathname + destination.search, cookie: renewedModerator(headers) };
  }

  try {
    const matching = Array.from({ length: pageSize + 1 }, (_, index) => row(index));
    // The oldest two share an instant at the page boundary. Insert the second
    // one last so its higher ID breaks the tie, and reverse the remaining insert
    // order to distinguish chronological ordering from ID ordering.
    const inserts = [
      matching[0],
      ...matching.slice(2).reverse(),
      { ...row(pageSize + 1), subject_id: `Different fixture ${moderatorId}` },
      { ...row(pageSize + 2), causer_id: String(actor + 1n) },
      matching[1],
    ];
    const inserted = await sql`
      insert into activity_log ${sql(inserts, "description", "subject_type", "subject_id", "causer_id", "created_at")}
      returning id
    `;
    seededIds = inserted.map(({ id }) => id);
    const newestFirst = matching.toReversed();
    const first = `${path}?${new URLSearchParams(filters)}`;
    for (const [target, owned] of [
      [kit, true],
      [off, false],
    ]) {
      const cookie = await session(sql, moderatorId, true);
      const next = await readPage(target, first, cookie, owned, 1, newestFirst.slice(0, pageSize));
      await readPage(target, next.href, next.cookie, owned, 2, newestFirst.slice(pageSize));
    }
  } finally {
    try {
      await sql.begin(async (tx) => {
        await tx`delete from web_session_grace where user_id = ${moderatorId}`;
        await tx`delete from web_sessions where user_id = ${moderatorId}`;
        if (seededIds.length) {
          // The historical synthetic rows qualify for ordinary retention cleanup.
          // The hosted job discards the new, append-only access receipts with its database.
          const removed =
            await tx`delete from activity_log where id in ${tx(seededIds)} returning id`;
          assert.equal(removed.length, seededIds.length, "synthetic activity rows removed");
        }
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed Kit and Hono activity log filtering, pagination, private no-store and fixture cleanup",
  );
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

function eventEditFields(html, path) {
  const forms = elements(parse(html)).filter(
    (el) => el.tagName === "form" && attr(el, "data-event-editor") !== undefined,
  );
  assert.equal(forms.length, 1, "one event editor form");
  assert.equal(attr(forms[0], "method"), "post");
  assert.equal(attr(forms[0], "action"), path);
  return submittedFields(forms[0]);
}

async function assertEventEditFallback({
  kit,
  off,
  sql,
  eventPath,
  editHtml,
  moderatorId,
  moderatorCookie,
  member,
}) {
  const key = eventPath.split("/").at(-1);
  const fields = eventEditFields(editHtml, eventPath);
  const baseline = fields.saved_baseline;
  assert.match(baseline ?? "", /^[0-9a-f]{64}$/, "the Kit editor renders a saved baseline");
  const moderator = { ...html, cookie: moderatorCookie };
  const title = "Fixture admin draft edited on Kit";
  const body = new URLSearchParams({ ...fields, title });
  const post = { method: "POST", body };

  async function snapshot() {
    const series = await sql`
      select id, event_key, title, description, status, starts_at, ends_at, timezone, updated_at,
        recurrence_frequency, recurrence_count, recurrence_ends_on, recurrence_index, parent_event_id
      from events
      where event_key = ${key} or parent_event_id = (select id from events where event_key = ${key})
      order by recurrence_index
    `;
    const event = series.find((row) => row.event_key === key);
    assert.ok(event, "the synthetic event exists");
    const occurrences = series.filter((row) => row !== event);
    const activity = await sql`
      select id, description, causer_id, properties from activity_log
      where subject_type = 'Event' and subject_id in ${sql(series.map((row) => row.event_key))}
      order by id
    `;
    return { event, occurrences, activity: [...activity] };
  }

  const before = await snapshot();
  assert.equal(fields.title, before.event.title, "the Kit editor renders the original title");
  assert.equal(before.event.recurrence_frequency, "weekly");
  assert.equal(before.event.recurrence_count, 2);
  assert.equal(before.event.recurrence_ends_on?.toISOString().slice(0, 10), "2099-10-08");
  assert.equal(before.event.recurrence_index, 1);
  assert.deepEqual(
    before.occurrences.map(({ recurrence_index, parent_event_id }) => [
      recurrence_index,
      parent_event_id,
    ]),
    [[2, before.event.id]],
    "one future occurrence belongs to the event",
  );
  await visit(kit, eventPath, 403, { ...post, headers: { ...html, cookie: member } });
  assert.deepEqual(await snapshot(), before, "a member cannot edit the event or append audit");

  const saved = await visit(kit, eventPath, 303, { ...post, headers: moderator });
  assert.equal(saved.headers.get("location"), `${eventPath}?saved=1`);
  const committed = await snapshot();
  const { updated_at: updatedAt, ...event } = committed.event;
  const { updated_at: previousUpdate, ...previousEvent } = before.event;
  assert.ok(updatedAt > previousUpdate, "the save advances the event version");
  assert.deepEqual(
    event,
    { ...previousEvent, title },
    "the edit preserves schedule and recurrence",
  );
  assert.deepEqual(committed.occurrences, before.occurrences, "the edit preserves the occurrence");
  assert.equal(committed.activity.length, before.activity.length + 1, "one audit row for the edit");
  assert.deepEqual(committed.activity.slice(0, -1), before.activity);
  const receipt = committed.activity.at(-1);
  assert.equal(receipt.causer_id, moderatorId);
  assert.equal(receipt.description, `updated event ${title}`);
  assert.deepEqual(receipt.properties.title, { before: before.event.title, after: title });

  const fallback = await visit(off, eventPath, 200, { owned: false, headers: moderator });
  const current = eventEditFields(fallback.text, eventPath);
  assert.equal(current.title, title, "Hono renders the committed title in the edit control");
  assert.match(current.saved_baseline ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(current.saved_baseline, baseline, "Hono renders a fresh baseline after the edit");

  const unsavedTitle = "Keep this unsaved event title";
  const unsavedDescription = "Keep these unsaved event notes";
  const stale = await visit(off, eventPath, 409, {
    method: "POST",
    body: new URLSearchParams({
      ...fields,
      title: unsavedTitle,
      description: unsavedDescription,
      saved_baseline: baseline,
    }),
    owned: false,
    headers: { ...moderator, cookie: renewedModerator(fallback.headers) },
  });
  assert.equal(stale.headers.get("location"), null);
  assert.match(stale.text, /data-testid="stale-save"/);
  assert.match(stale.text, /data-event-draft=""/);
  const retained = eventEditFields(stale.text, eventPath);
  assert.equal(retained.title, unsavedTitle);
  assert.equal(retained.description, unsavedDescription);
  assert.equal(retained.saved_baseline, baseline);
  assert.deepEqual(await snapshot(), committed, "the stale save leaves the event and audit intact");
}

async function assertKitEventEditRedirectServing({
  kit,
  nativeEdit,
  off,
  hono,
  cookie,
  member,
  eventPath,
}) {
  const alias = `${eventPath}/edit?ignored=1&ignored=2&next=%2F%2Fexample.invalid`;
  for (const target of [kit, nativeEdit, off, hono]) {
    const owned = target === nativeEdit;
    for (const method of ["HEAD", "GET"]) {
      const guest = await visit(target, alias, 302, { method, owned });
      assert.equal(guest.headers.get("location"), "/auth/discord");
      const intended = guest.headers.getSetCookie();
      assert.equal(intended.length, 1);
      assert.ok(intended[0].startsWith(`__Host-two_login_intended=${encodeURIComponent(alias)}.`));
      const denied = await visit(target, alias, 403, {
        method,
        owned,
        headers: { cookie: member },
      });
      assert.equal(denied.headers.get("location"), null);
      assert.equal(denied.headers.getSetCookie().length, 0);
    }
    const moderator = await cookie();
    const head = await visit(target, alias, 301, {
      method: "HEAD",
      owned,
      headers: { cookie: moderator },
    });
    assert.equal(head.headers.get("location"), eventPath);
    assert.equal(head.headers.getSetCookie().length, 0);
    const redirect = await visit(target, alias, 301, { owned, headers: { cookie: moderator } });
    assert.equal(redirect.headers.get("location"), eventPath);
    assert.match(redirect.headers.get("content-type") ?? "", /^text\/plain\b/);
    assert.equal(redirect.text, "");
    assert.notEqual(renewedModerator(redirect.headers), moderator);
    if (owned) {
      const form = await visit(target, eventPath, 200, {
        headers: { ...html, cookie: renewedModerator(redirect.headers) },
      });
      assert.match(form.text, /Edit Fixture admin draft/);
    }
  }

  const unknown = "/admin/events/01J00000000000000000000000";
  const encodedKey = eventPath.replace(
    /\/([^/])([^/]*)$/,
    (_segment, first, rest) => `/%${first.charCodeAt(0).toString(16)}${rest}`,
  );
  for (const target of [nativeEdit, hono]) {
    const owned = target === nativeEdit;
    const missing = await visit(target, `${unknown}/edit?ignored=1`, 301, {
      owned,
      headers: { cookie: await cookie() },
    });
    assert.equal(missing.headers.get("location"), unknown);
    await visit(target, unknown, 404, {
      owned,
      headers: { cookie: renewedModerator(missing.headers) },
    });
    const encoded = "/admin/events/a%2Fb%3Fc%23d%25";
    for (const [path, location] of [
      [encoded, encoded],
      [encodedKey, eventPath],
    ]) {
      const redirect = await visit(target, `${path}/edit?ignored=1`, 301, {
        owned: false,
        headers: { cookie: await cookie() },
      });
      assert.equal(redirect.headers.get("location"), location);
    }
    for (const path of [`${eventPath}/edit/`, `${eventPath}/edit/__data.json`]) {
      const fallback = await visit(target, path, 302, { owned: false });
      assert.equal(fallback.headers.get("location"), "/auth/discord");
    }
    const moderator = await cookie();
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const fallback = await visit(target, alias, 404, {
        method,
        owned: false,
        headers: { cookie: moderator },
      });
      assert.equal(fallback.headers.get("location"), null);
      assert.equal(fallback.headers.getSetCookie().length, 0);
    }
  }
  console.log("PASS installed Worker legacy event edit redirect with Kit ownership off and on");
}

export async function assertKitAdminServing({
  kit,
  nativeCreate,
  nativeEdit,
  off,
  hono,
  databaseUrl,
}) {
  await assertActivityLogReadParity({ kit, off, databaseUrl });
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const memberId = String(actor + 1n);
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const { assertRecurringCreateParity } = await import("./kit-admin-recurring-create.mjs");
    await assertRecurringCreateParity({
      kit,
      sql,
      visit,
      session,
      actors: { kit: String(actor + 2n), hono: String(actor + 3n) },
    });
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
        description: "Fixture draft notes\nSecond line & example",
        starts_at: "2099-10-01T12:00",
        ends_at: "2099-10-01T13:00",
        timezone: "UTC",
        recurrence_frequency: "weekly",
        recurrence_count: "2",
        recurrence_ends_on: "2099-10-08",
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
    assert.equal(events, 3, "the series has two occurrences and duplicate adds one draft");
    assert.equal(writes, 7, "accepted mutations audit each affected row once");

    await assertAdminDuplicateServing({
      kit,
      off,
      hono,
      sql,
      moderatorId,
      moderator,
      member,
      visit,
    });

    // A seeded key makes the parameter route observable next to the static
    // form and exact alias. Both installed modes keep the other forms in Kit.
    let kitEdit;
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
      assert.ok(existing.text.includes(`action="${eventPath}/duplicate"`));
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
      const latest = renewedModerator(legacyEdit.headers);
      await visit(target, legacyCreate, 413, {
        ...form,
        owned,
        body: "x".repeat(65537),
        headers: { ...form.headers, cookie: latest },
      });
      if (target === kit) {
        kitEdit = existing.text;
        moderator = latest;
      }
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
    // Check the original draft before the edit fallback changes its title.
    // Missing routes may cache suggestions, so run this before publishing
    // temporary public events as well.
    await assertKitEventEditRedirectServing({
      kit,
      nativeEdit,
      off,
      hono,
      cookie: () => session(sql, moderatorId, true),
      member,
      eventPath,
    });

    // Draft edits have no Discord mirror; the queue stub serves publish requests only.
    assert.ok(kitEdit, "the installed Kit editor was reached");
    await assertEventEditFallback({
      kit,
      off,
      sql,
      eventPath,
      editHtml: kitEdit,
      moderatorId,
      moderatorCookie: moderator,
      member,
    });

    await assertAdminPublish({ kit, off, hono, sql, moderatorId, member });
  } finally {
    try {
      // Audit rows are append-only and are isolated by the synthetic actor.
      // The hosted job discards the disposable database at teardown.
      await sql.begin(async (tx) => {
        await tx`delete from featured_contents where created_by = ${moderatorId}`;
        await tx`delete from events where created_by = ${moderatorId}`;
        await tx`delete from web_session_grace where user_id in (${moderatorId}, ${memberId})`;
        await tx`delete from web_sessions where user_id in (${moderatorId}, ${memberId})`;
        const [remaining] = await tx`select
          exists(select 1 from events where created_by = ${moderatorId}) as events,
          exists(select 1 from web_sessions where user_id in (${moderatorId}, ${memberId})) as sessions,
          exists(select 1 from web_session_grace where user_id in (${moderatorId}, ${memberId})) as grace`;
        assert.deepEqual(remaining, { events: false, sessions: false, grace: false });
      });
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed event edit and Hono stale retry preserve one audit row; fixtures cleaned up",
  );
  console.log("PASS Kit admin ownership, isolated bearers, and native form parity");
}

export async function assertInstalledJoinAttemptDetail({ worker, scratch, databaseUrl, start }) {
  const { assertJoinAttemptDetailParity, startJoinAttemptDetailFixture } = await import(
    "./kit-admin-join-attempt-detail.mjs"
  );
  const target = await startJoinAttemptDetailFixture({ worker, scratch, start });
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await assertJoinAttemptDetailParity({ worker: target, sql, visit, session, renewedModerator });
  } finally {
    await sql.end({ timeout: 1 });
  }
}
