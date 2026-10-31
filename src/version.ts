// `GET /version`: what is live, for the owner and for deploy checks. Both
// fields come from the `version_metadata` binding, so the deploy workflows
// stamp nothing new: `sha` is the commit the deploy tagged the Worker Version
// with (parsed by src/release-tag.ts, a full lowercase SHA-1 or `null`), and
// `deployedAt` is the time Cloudflare recorded for that Version's upload, as
// ISO 8601 UTC. Staging and production both upload right before they serve,
// and a rollback serves the older Version with its own values, so the body
// always describes the code that answered. No database read, no member data.
import { buildShaFromTag } from "./release-tag";

export type VersionBody = { sha: string | null; deployedAt: string | null };

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function versionBody(
  meta: { tag?: unknown; timestamp?: unknown } | null | undefined,
): VersionBody {
  return { sha: buildShaFromTag(meta?.tag), deployedAt: isoTimestamp(meta?.timestamp) };
}
