import assert from "node:assert/strict";
import { hashToken, SESSION_TTL_SECONDS, type Sql } from "../../src/sessions";

// Shared by the CLI's real-clock and controlled-skew SQL proofs, never app auth.
export async function verifyCaptureSession(
  sql: Sql,
  token: string,
  persona: "member" | "moderator",
  processNow = Date.now(),
) {
  const expiryUpperBound = new Date(processNow + SESSION_TTL_SECONDS * 1000).toISOString();
  const rows = await sql`select member, moderator,
    expires_at > now() as unexpired,
    created_at > now() - interval '24 hours' as young,
    expires_at <= ${expiryUpperBound}::timestamptz as bounded
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
