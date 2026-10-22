// Overlay acceptance fixtures: capability-token minting and raw-SQL rows.
//
// The overlay tables land in the schema slice, after these tests. Fixtures
// therefore use raw SQL against the spec-pinned table and column names
// (spec section 3), never the store module, so this file typechecks at base
// and fails loudly (missing relation) until the migration exists.
import { createHash, randomBytes } from "node:crypto";
import type { MemberDataFixture } from "./member-data-db";

export function mintOverlayToken(): string {
  return `two_ov_${randomBytes(32).toString("base64url")}`;
}

// Spec pins SHA-256 hex storage. Computed directly so fixtures never couple
// to the session store's helper.
export function overlayTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function clearOverlayTables(fixture: MemberDataFixture): Promise<void> {
  await fixture.client`DELETE FROM overlay_tokens`;
  await fixture.client`DELETE FROM overlay_configs`;
}

export async function insertOverlayToken(
  fixture: MemberDataFixture,
  opts: { token: string; memberId: string; status?: string; rotatedAt?: Date },
): Promise<void> {
  const hash = overlayTokenHash(opts.token);
  if (opts.rotatedAt) {
    // ISO text, not a Date object: the driver's prepared-statement path
    // rejects Date params here, while timestamptz parses ISO text.
    const rotatedAt = opts.rotatedAt.toISOString();
    await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status, rotated_at)
      VALUES (${opts.memberId}, ${hash}, ${opts.status ?? "rotated"}, ${rotatedAt})`;
  } else {
    await fixture.client`INSERT INTO overlay_tokens (member_id, token_hash, status)
      VALUES (${opts.memberId}, ${hash}, ${opts.status ?? "live"})`;
  }
}

export async function insertOverlayConfig(
  fixture: MemberDataFixture,
  memberId: string,
): Promise<void> {
  await fixture.client`INSERT INTO overlay_configs (member_id, elements, theme)
    VALUES (${memberId}, '{}'::jsonb, '{}'::jsonb)`;
}
