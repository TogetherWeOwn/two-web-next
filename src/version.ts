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

export function versionBody({
  tag,
  timestamp: t,
}: {
  tag?: unknown;
  timestamp?: unknown;
} = {}): VersionBody {
  // NaN (unparseable or empty), false (not a string) and the epoch read as unknown.
  const ms = typeof t === "string" && Date.parse(t);
  return { sha: buildShaFromTag(tag), deployedAt: ms ? new Date(ms).toISOString() : null };
}
