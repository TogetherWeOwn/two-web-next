// Staging-only QA sign-in. Legacy port of two-web `StagingQaLoginController`:
// two deterministic identities, constant-time token check, unknown identity
// and bad token are byte-identical 404s, and a blank configured token always
// fails closed. The session written here is a normal DB session through the
// same store and cookie as a Discord login; the identities keep the legacy
// synthetic snowflakes so fixtures stay stable across the ports.
//
// Env gate: `APP_URL` must be the staging host (`https://next.togetherweown.com`)
// AND `QA_AUTH_TOKEN` must be set. Anywhere else the route does not exist (404).

export const QA_HEADER = "X-TWO-QA-Auth";
export const QA_MODERATOR_ROLE_ID = "508654771276873729";

export type QaIdentity = { discordId: string; username: string; moderator: boolean };

export const QA_IDENTITIES: Record<string, QaIdentity> = {
  "qa-member": { discordId: "900000000000001396", username: "QA Member", moderator: false },
  "qa-moderator": { discordId: "900000000000001397", username: "QA Moderator", moderator: true },
};

export function qaIdentity(name: string): QaIdentity | undefined {
  return Object.hasOwn(QA_IDENTITIES, name) ? QA_IDENTITIES[name] : undefined;
}

export const STAGING_APP_URL = "https://next.togetherweown.com";

export function qaEnabled(appUrl: string, qaToken: string | undefined): boolean {
  return appUrl === STAGING_APP_URL && !!qaToken;
}

const sha256 = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

/** Constant-time compare. Blank configured token always fails closed. */
export async function qaTokenMatches(configured: string | undefined, presented: string): Promise<boolean> {
  if (!configured) return false;
  const [a, b] = await Promise.all([sha256(configured), sha256(presented)]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
