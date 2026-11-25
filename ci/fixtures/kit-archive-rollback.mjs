import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateSignedCookie } from "hono/cookie";
import postgres from "postgres";
import { PRODUCTION_APEX } from "../../src/http/robots.ts";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import { FIXTURE_SECRETS, SESSION_COOKIE } from "../parity/fixture.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

const appUrl = `https://${PRODUCTION_APEX}`;
const clientIp = "192.0.2.163";
const memberId = "900000000000090163";
const memberName = "Synthetic Archive Member";
const query = "Ember % & Archive";
const encoded = new URLSearchParams({ q: query }).toString();
const firstPage = `/events/past?${encoded}`;
const bookmark = `/events/past?page=2&${encoded}`;
const records = Array.from({ length: 23 }, (_, index) => {
  // The newest row matches only if SQL treats the percent sign as a wildcard.
  const decoy = index === 22;
  const day = decoy ? 24 : 23 - index;
  return {
    event_key: `01J0000000000000000000B${String(index).padStart(3, "0")}`,
    title: decoy ? "Ember Wildcard & Archive" : `${query} Night ${index + 1}`,
    starts_at: new Date(Date.UTC(2020, 0, day, 18)),
    ends_at: new Date(Date.UTC(2020, 0, day, 20)),
    timezone: "UTC",
    status: "past",
  };
});
const matching = records.slice(0, 22);

function byTestId(root, tag, id) {
  return [...renderedElements(root, { tag })].filter(
    (node) => renderedAttribute(node, "data-testid") === id,
  );
}

function assertCanonical(html, path, label) {
  const canonicals = [...renderedElements(html, { tag: "link" })]
    .filter((link) => renderedAttribute(link, "rel") === "canonical")
    .map((link) => renderedAttribute(link, "href"));
  assert.deepEqual(canonicals, [`${appUrl}${path}`], `${label}: canonical URL`);
}

function assertDetail({ html, label }, permalink, title) {
  assertCanonical(html, permalink, label);
  assert.deepEqual(
    [...renderedElements(html, { tag: "h1" })].map(renderedText),
    [title],
    `${label}: detail title`,
  );
}

function assertArchive(html, path, page, expected, label) {
  assertCanonical(html, path, label);
  const [section] = byTestId(html, "section", "past-events");
  assert.ok(section, `${label}: archive section`);
  assert.equal(renderedAttribute(section, "data-page"), String(page), `${label}: page number`);
  assert.equal(renderedAttribute(section, "data-total-pages"), "2", `${label}: two pages`);
  assert.equal(renderedAttribute(section, "data-query"), query, `${label}: query round trip`);
  const actual = byTestId(section, "li", "event-card").map((card) => {
    const [heading] = renderedElements(card, { tag: "h2" });
    assert.ok(heading, `${label}: card heading`);
    const [link] = renderedElements(heading, { tag: "a" });
    assert.ok(link, `${label}: card link`);
    return {
      key: renderedAttribute(card, "data-event-key"),
      title: renderedText(link),
      href: renderedAttribute(link, "href"),
    };
  });
  const context = new URLSearchParams({ archivePage: page, archiveQuery: query });
  assert.deepEqual(
    actual,
    expected.map(({ event_key, title }) => ({
      key: event_key,
      title,
      href: `/e/${event_key}?${context}`,
    })),
    `${label}: ordered search results and detail links`,
  );
  const [pager] = byTestId(section, "nav", "past-events-pager");
  assert.ok(pager, `${label}: pager`);
  assert.deepEqual(
    [...renderedElements(pager, { tag: "a" })].map((link) => renderedAttribute(link, "href")),
    [page === 1 ? bookmark : firstPage],
    `${label}: search pager preserves the query`,
  );
  return actual;
}

/** Called by the installed-output runner after it validates the disposable database URL. */
export async function assertArchiveRollback({ worker, scratch, databaseUrl, start }) {
  const entry = join(scratch, "kit-archive-rollback.mjs");
  // The archive selector admits only the canonical HTTPS authority. Present it
  // inside the installed Worker while the client and database stay on loopback.
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import inner from ${JSON.stringify(worker)};
let outbound = false;
globalThis.fetch = async () => {
  outbound = true;
  throw new Error("Archive rollback fixture forbids outbound HTTP");
};
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico") return inner.fetch(request, env, context);
    const profiles = {
      archive: { ...${JSON.stringify(EMBER_CUTOVER_VARS)}, KIT_ROUTE_ARCHIVE: "true" },
      ember: ${JSON.stringify(EMBER_CUTOVER_VARS)},
      fallback: { KIT_ROUTE_EMBER_PAGES: "false", KIT_ROUTE_ARCHIVE: "false" },
    };
    const phase = request.headers.get("x-fixture-archive-phase");
    if (!Object.hasOwn(profiles, phase)) return new Response(null, { status: 400 });
    const bindings = { ...env, ...profiles[phase], APP_URL: ${JSON.stringify(appUrl)} };
    const documentUrl = new URL(bindings.APP_URL);
    documentUrl.pathname = url.pathname;
    documentUrl.search = url.search;
    const document = new Request(documentUrl, request);
    document.headers.delete("x-fixture-archive-phase");
    document.headers.set("host", documentUrl.host);
    document.headers.set("sec-fetch-mode", "navigate");
    document.headers.set("sec-fetch-dest", "document");
    document.headers.set("cf-connecting-ip", ${JSON.stringify(clientIp)});
    const response = await withEnv(bindings, () => inner.fetch(document, bindings, context));
    if (outbound) throw new Error("Archive rollback fixture attempted outbound HTTP");
    return response;
  },
};\n`,
  );
  const origin = await start(entry);

  async function get(path, phase, owner, cookie) {
    const label = `${phase}: ${path}`;
    const response = await fetch(`${origin}${path}`, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: { accept: "text/html", "x-fixture-archive-phase": phase, ...(cookie && { cookie }) },
    });
    const html = parseRenderedPage(await response.text());
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get("x-two-renderer"), owner, `${label}: owner`);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/, label);
    assert.equal(response.headers.get("cache-control"), "private, no-store", label);
    return { html, headers: response.headers, label };
  }

  const sql = postgres(databaseUrl, { max: 1 });
  let seeded = false;
  try {
    const token = `two_${randomBytes(32).toString("base64url")}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await sql.begin(async (tx) => {
      const [existing] = await tx`
        select exists (select 1 from web_sessions where user_id = ${memberId}
          union all select 1 from web_session_grace where user_id = ${memberId}
          union all select 1 from member_data_access_logs where viewer_discord_id = ${memberId}
          union all select 1 from web_throttle_hits where bucket = ${`events-read:${clientIp}`}) as occupied`;
      assert.equal(existing.occupied, false, "archive fixture identities must be unused");
      await tx`insert into events ${tx(records)}`;
      await tx`insert into web_sessions (token_hash, user_id, username, member, expires_at, roles_checked_at)
        values (${hash}, ${memberId}, ${memberName}, true, now() + interval '10 minutes', now())`;
    });
    seeded = true;
    let cookie = (
      await generateSignedCookie(SESSION_COOKIE, token, FIXTURE_SECRETS.SESSION_SECRET, {
        path: "/",
        secure: true,
      })
    ).split(";", 1)[0];

    const first = await get(firstPage, "archive", "kit");
    assertArchive(first.html, firstPage, 1, matching.slice(0, 20), first.label);
    const ember = await get(bookmark, "ember", null);
    assertArchive(ember.html, bookmark, 2, matching.slice(20), ember.label);

    const detail = matching[20];
    const permalink = `/e/${detail.event_key}`;
    let savedDetailHref;
    for (const [phase, owner] of [
      ["archive", "kit"],
      ["fallback", null],
    ]) {
      const { html, headers, label } = await get(bookmark, phase, owner, cookie);
      assert.equal(headers.getSetCookie().length, 0, `${label}: archive leaves the session alone`);
      const [result] = assertArchive(html, bookmark, 2, matching.slice(20), label);
      savedDetailHref ??= result.href;
      assert.equal(result.href, savedDetailHref, `${label}: saved detail link`);

      // Detail is Hono-owned in both profiles. Follow the link saved before
      // fallback and check the session passed from the preceding response.
      const page = await get(savedDetailHref, phase, null, cookie);
      assertDetail(page, permalink, detail.title);
      const back = [...renderedElements(page.html, { tag: "a" })].find(
        (link) => renderedText(link).trim() === "← Back to search results",
      );
      assert.ok(back, `${page.label}: archive return link`);
      assert.equal(renderedAttribute(back, "href"), bookmark, `${page.label}: return to page two`);
      const session = page.headers
        .getSetCookie()
        .find((value) => value.startsWith(`${SESSION_COOKIE}=`));
      assert.ok(session, `${page.label}: Hono renews the signed-in session`);
      const renewed = session.split(";", 1)[0];
      assert.ok(renewed !== cookie, `${page.label}: session bearer rotated`);
      cookie = renewed;
    }

    // A fresh visit to the canonical permalink must accept Hono's replacement.
    const revisit = await get(permalink, "fallback", null, cookie);
    assertDetail(revisit, permalink, detail.title);
    const account = [...renderedElements(revisit.html, { tag: "form" })].find(
      (form) => renderedAttribute(form, "action") === "/logout",
    );
    assert.ok(account, `${revisit.label}: replacement signs in on Hono`);
    assert.ok(
      renderedText(account).includes(memberName),
      `${revisit.label}: same synthetic member`,
    );
  } finally {
    try {
      if (seeded) {
        await sql.begin(async (tx) => {
          await tx`delete from web_session_grace where user_id = ${memberId}`;
          await tx`delete from web_sessions where user_id = ${memberId}`;
          await tx`delete from member_data_access_logs where viewer_discord_id = ${memberId}`;
          await tx`delete from events where event_key in ${tx(records.map((row) => row.event_key))}`;
          await tx`delete from web_throttle_hits where bucket = ${`events-read:${clientIp}`}`;
        });
      }
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed Kit archive opt-in, Ember ownership and Hono rollback preserve saved results and detail",
  );
}
