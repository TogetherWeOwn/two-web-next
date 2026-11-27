import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { session, visit } from "./kit-admin-serving.mjs";

export async function assertFeaturedDeleteParity({ kit, off, databaseUrl }) {
  const actor = 900000000000000000n + BigInt(`0x${randomBytes(7).toString("hex")}`);
  const moderatorId = String(actor);
  const memberId = String(actor + 1n);
  const ip = "192.0.2.194";
  const sql = postgres(databaseUrl, { max: 1 });
  const title = "Disposable featured delete fixture";
  const body = "Synthetic copy for the delete receipt";
  const startsAt = "2099-01-01 12:00:00.123456";

  async function snapshot(id) {
    const [row] = await sql`select * from featured_contents where id = ${id}`;
    const receipts = await sql`
      select log_name, causer_id, description, properties from activity_log
      where subject_type = 'FeaturedContent' and subject_id = ${String(id)} order by id
    `;
    return { row, receipts: [...receipts] };
  }

  try {
    const moderator = await session(sql, moderatorId, true);
    const member = await session(sql, memberId, false);
    const [kitRow, honoRow] = await sql`
      insert into featured_contents (title, body, starts_at, created_by)
      values (${title}, ${body}, ${`${startsAt}+00`}, ${moderatorId}),
             (${title}, ${body}, ${`${startsAt}+00`}, ${moderatorId}) returning id
    `;
    const list = "/admin/featured";

    for (const [target, id] of [
      [kit, kitRow.id],
      [off, honoRow.id],
    ]) {
      const owned = target === kit;
      const path = `${list}/${id}/delete`;
      const headers = { accept: "text/html", "cf-connecting-ip": ip, "x-forwarded-for": ip };
      const form = { method: "POST", owned, body: new URLSearchParams() };
      const admitted = { ...form, headers: { ...headers, cookie: moderator } };
      const before = await snapshot(id);
      assert.equal(before.row.created_by, moderatorId);
      assert.deepEqual(before.receipts, []);

      const guest = await visit(target, path, 303, { ...form, headers });
      assert.equal(guest.headers.get("location"), "/auth/recover?next=%2Fadmin%2Ffeatured");
      assert.equal(guest.headers.getSetCookie().length, 1);
      const denied = await visit(target, path, 403, {
        ...form,
        headers: { ...headers, cookie: member },
      });
      assert.match(denied.text, /You do not have access to this/);
      assert.equal(denied.headers.get("location"), null);
      assert.equal(denied.headers.getSetCookie().length, 0);
      await visit(target, path, 403, {
        ...admitted,
        headers: { ...admitted.headers, origin: "https://cross-origin.invalid" },
      });
      await visit(target, path, 413, { ...admitted, body: "x".repeat(4097) });
      assert.deepEqual(await snapshot(id), before, "refusals leave the row and audit untouched");

      const deleted = await visit(target, path, 303, admitted);
      assert.equal(deleted.headers.get("location"), list);
      assert.equal(deleted.headers.getSetCookie().length, 0);
      const after = await snapshot(id);
      assert.equal(after.row, undefined);
      assert.deepEqual(after.receipts, [
        {
          log_name: "default",
          causer_id: moderatorId,
          description: `deleted featured content ${title}`,
          properties: {
            title: { before: title, after: null },
            body: { before: body, after: null },
            isPublished: { before: false, after: null },
            position: { before: 0, after: null },
            startsAt: { before: startsAt, after: null },
          },
        },
      ]);

      const missing = await visit(target, path, 404, admitted);
      assert.match(missing.text, /Featured content not found/);
      assert.equal(missing.headers.get("location"), null);
      assert.deepEqual(await snapshot(id), after, "a repeat does not add a deletion receipt");
    }
  } finally {
    try {
      // Receipts are append-only. The hosted job discards the disposable database.
      await sql`delete from featured_contents where created_by = ${moderatorId}`;
      await sql`delete from web_sessions where user_id in (${moderatorId}, ${memberId})`;
      await sql`delete from web_throttle_hits where bucket = ${`admin-write:${ip}`}`;
    } finally {
      await sql.end({ timeout: 1 });
    }
  }
  console.log(
    "PASS installed Worker featured delete admission, transaction audit, and Hono fallback",
  );
}
