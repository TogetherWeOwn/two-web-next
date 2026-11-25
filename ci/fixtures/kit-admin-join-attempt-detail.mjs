import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EMBER_CUTOVER_VARS } from "../kit-cutover-evidence.mjs";
import {
  parseRenderedPage,
  renderedAttribute,
  renderedElements,
  renderedText,
} from "../rendered-page.mjs";

const listPath = "/admin/join-attempts";
const appUrl = "https://two-web-kit-cutover-proof-1-1.join-attempt-fixture.workers.dev";
const profileHeader = "x-fixture-join-attempt-admin";

export async function startJoinAttemptDetailFixture({ worker, scratch, start }) {
  const entry = join(scratch, "kit-admin-join-attempt-detail.mjs");
  // An unscoped loopback URL selects the preview manifest, which already
  // owns this GET. Use the real cutover host gate, with transport on loopback.
  await writeFile(
    entry,
    `import { withEnv } from "cloudflare:workers";
import worker from ${JSON.stringify(worker)};
let outbound = false;
globalThis.fetch = async () => {
  outbound = true;
  throw new Error("Join-attempt detail fixture forbids outbound HTTP");
};
export default {
  async fetch(request, env, context) {
    const local = new URL(request.url);
    if (local.pathname === "/favicon.ico") return worker.fetch(request, env, context);
    if (request.method !== "GET" || !/^\\/admin\\/join-attempts\\/\\d+$/.test(local.pathname)) {
      return new Response(null, { status: 404 });
    }
    const admin = request.headers.get(${JSON.stringify(profileHeader)});
    if (admin !== "true" && admin !== "false") return new Response(null, { status: 400 });
    const bindings = { ...env, KIT_ROUTE_ADMIN: admin, APP_URL: ${JSON.stringify(appUrl)} };
    const url = new URL(local.pathname + local.search, bindings.APP_URL);
    const document = new Request(url, request);
    document.headers.delete(${JSON.stringify(profileHeader)});
    document.headers.set("host", url.host);
    if (document.headers.get("origin") === local.origin) document.headers.set("origin", url.origin);
    const response = await withEnv(bindings, () => worker.fetch(document, bindings, context));
    if (outbound) throw new Error("Join-attempt detail fixture attempted outbound HTTP");
    return response;
  },
};
`,
  );
  return start(entry, EMBER_CUTOVER_VARS);
}

export async function assertJoinAttemptDetailParity({
  worker,
  sql,
  visit,
  session,
  renewedModerator,
}) {
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorIds = [String(actor), String(actor + 1n)];
  const memberId = String(actor + 2n);
  const subjectId = String(actor + 3n);
  const legacyId = String(actor + 4n);
  const requestMarker = `fixture-attempt-${subjectId}`;
  const requestId = `${requestMarker} & <em>trace</em>`;
  const source = "fixture-detail-source";
  const outcome = "denied";
  const createdAt = new Date();
  const instant = createdAt.toISOString();
  const actorIds = [...moderatorIds, memberId];

  async function accessFor(viewers) {
    return [
      ...(await sql`
      select viewer_discord_id, viewer_user_id, resource, action, route, subject_user_ids, subject_count
      from member_data_access_logs where viewer_discord_id in ${sql(viewers)}
    `),
    ];
  }

  try {
    const [{ id }] = await sql`
      insert into join_attempts (legacy_id, outcome, source, request_id, discord_id, created_at)
      values (${legacyId}, ${outcome}, ${source}, ${requestId}, ${subjectId}, ${createdAt})
      returning id
    `;
    // Reserve a canonical ID without inserting a row at that ID.
    const [{ id: missingId }] =
      await sql`select nextval(pg_get_serial_sequence('join_attempts', 'id')) as id`;
    const detailPath = `${listPath}/${id}`;
    const missingPath = `${listPath}/${missingId}`;
    const member = await session(sql, memberId, false);

    for (const [owned, moderatorId] of [
      [false, moderatorIds[0]],
      [true, moderatorIds[1]],
    ]) {
      const target = {
        ...worker,
        name: owned ? "Cutover Admin on" : "Cutover Admin off",
        headers: { [profileHeader]: String(owned) },
      };
      async function read(path, status, cookie, heading) {
        const label = `${target.name} ${status} ${path}`;
        const response = await visit(target, path, status, {
          headers: { accept: "text/html", cookie },
          owned,
        });
        const { headers, text } = response;
        assert.match(headers.get("content-type") ?? "", /^text\/html\b/i, label);
        assert.match(headers.get("cache-control") ?? "", /\bprivate\b/i, label);
        assert.equal(headers.get("location"), null, label);
        assert.equal(headers.get("etag"), null, label);
        assert.ok(!text.includes(legacyId), `${label} keeps the legacy ID out of HTML`);

        const [main] = renderedElements(parseRenderedPage(text), { tag: "main" });
        assert.ok(main, `${label} has a main landmark`);
        const headings = [...renderedElements(main, { tag: "h1" })];
        assert.deepEqual(
          headings.map((el) => renderedText(el).trim()),
          [heading],
          label,
        );
        if (status !== 200) {
          for (const value of [requestMarker, subjectId, source, instant]) {
            assert.ok(!text.includes(value), `${label} keeps the attempt out of HTML`);
          }
        }
        return { headers, text, main };
      }

      const moderator = await session(sql, moderatorId, true);
      const detail = await read(detailPath, 200, moderator, `Join attempt ${id}`);
      const fields = [...renderedElements(detail.main, {})]
        .filter(({ tagName }) => tagName === "dt" || tagName === "dd")
        .map((element) => [element.tagName, renderedText(element).trim()]);
      assert.deepEqual(
        fields,
        [
          ["dt", "Outcome"],
          ["dd", outcome],
          ["dt", "Source"],
          ["dd", source],
          ["dt", "Attempted at (UTC)"],
          ["dd", instant],
          ["dt", "Request ID"],
          ["dd", requestId],
          ["dt", "Discord ID"],
          ["dd", subjectId],
        ],
        `${target.name} visible detail fields`,
      );
      const times = [...renderedElements(detail.main, { tag: "time" })];
      assert.deepEqual(
        times.map((el) => renderedAttribute(el, "datetime")),
        [instant],
        `${target.name} UTC instant`,
      );
      assert.doesNotMatch(
        detail.text,
        /<em>trace<\/em>/,
        `${target.name} escapes stored trace text`,
      );
      assert.ok(
        [...renderedElements(detail.main, { tag: "a" })].some(
          (link) =>
            renderedAttribute(link, "href") === listPath &&
            renderedText(link).trim() === "Back to join attempts",
        ),
        `${target.name} has a link back to join attempts`,
      );

      const expectedAudit = [
        {
          viewer_discord_id: moderatorId,
          viewer_user_id: moderatorId,
          resource: "join_attempts",
          action: "view",
          route: "admin.join-attempts.show",
          subject_user_ids: [subjectId],
          subject_count: 1,
        },
      ];
      assert.deepEqual(await accessFor([moderatorId, memberId]), expectedAudit);

      const afterDetail = renewedModerator(detail.headers);
      const missing = await read(missingPath, 404, afterDetail, "Join attempt not found");
      const afterMissing = renewedModerator(missing.headers);
      assert.notEqual(afterMissing, afterDetail, `${target.name} renews the bearer on 404`);
      // Reuse the replacement on the missing ID to prove admission without a second audit row.
      await read(missingPath, 404, afterMissing, "Join attempt not found");
      for (const path of [detailPath, missingPath]) {
        const denied = await read(path, 403, member, "You do not have access to this");
        assert.equal(
          denied.headers.getSetCookie().length,
          0,
          "a refused member receives no cookie",
        );
      }
      assert.deepEqual(
        await accessFor([moderatorId, memberId]),
        expectedAudit,
        `${target.name} missing and refused requests add no access row`,
      );
    }
  } finally {
    // Access receipts are append-only. The hosted Postgres service is disposable.
    await sql.begin(async (tx) => {
      await tx`delete from join_attempts where legacy_id = ${legacyId}`;
      await tx`delete from web_session_grace where user_id in ${tx(actorIds)}`;
      await tx`delete from web_sessions where user_id in ${tx(actorIds)}`;
      const [remaining] = await tx`select
        exists(select 1 from join_attempts where legacy_id = ${legacyId}) as attempt,
        exists(select 1 from web_session_grace where user_id in ${tx(actorIds)}) as grace,
        exists(select 1 from web_sessions where user_id in ${tx(actorIds)}) as sessions`;
      assert.deepEqual(remaining, { attempt: false, grace: false, sessions: false });
    });
  }
  console.log(
    "PASS installed Admin join-attempt detail, missing row, member refusal and fixture cleanup",
  );
}
