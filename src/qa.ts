// Staging-only QA sign-in. Legacy port of two-web `StagingQaLoginController`:
// two deterministic identities, constant-time token check, unknown identity
// and bad token are byte-identical 404s, and a blank configured token always
// fails closed. The session written here is a normal DB session through the
// same store and cookie as a Discord login; the identities keep the legacy
// synthetic snowflakes so fixtures stay stable across the ports.
//
// Env gate: `APP_URL` must be the staging host (`https://next.togetherweown.com`)
// AND `QA_AUTH_TOKEN` must be set to a value of at least MIN_QA_TOKEN_LENGTH
// characters. Anywhere else the route does not exist (404).

export const QA_HEADER = "X-TWO-QA-Auth";

export type QaIdentity = { discordId: string; username: string; moderator: boolean };

export const QA_IDENTITIES: Record<string, QaIdentity> = {
  "qa-member": { discordId: "900000000000001396", username: "QA Member", moderator: false },
  "qa-moderator": { discordId: "900000000000001397", username: "QA Moderator", moderator: true },
};

export function qaIdentity(name: string): QaIdentity | undefined {
  return Object.hasOwn(QA_IDENTITIES, name) ? QA_IDENTITIES[name] : undefined;
}

export const STAGING_APP_URL = "https://next.togetherweown.com";

// The longest presented QA token the gate will hash, in characters. Anything
// longer refuses false before hashing — parity with the 512-char ingress
// bearer cap (src/agent-events/ingress.ts) so unbounded staging-probe headers
// cannot force a digest pre-throttle. Callers answer the existing
// byte-identical 404, so valid and short-bad-token behavior is unchanged.
export const MAX_QA_PRESENTED_TOKEN_LENGTH = 512;

// The shortest configured QA token the seam will run with, in characters.
// Same 32-character floor as the ops control token (src/admin/ops-overrides.tsx)
// and the source-evidence bearer (src/admin/source-evidence.ts): a shorter
// configured value leaves the route disabled (404) instead of running with a
// guessable secret. Surrounding whitespace never counts toward the floor and
// disables the seam too, matching the ops-token gate.
export const MIN_QA_TOKEN_LENGTH = 32;

export function qaEnabled(appUrl: string, qaToken: string | undefined): boolean {
  return (
    appUrl === STAGING_APP_URL &&
    !!qaToken &&
    qaToken.trim() === qaToken &&
    qaToken.length >= MIN_QA_TOKEN_LENGTH
  );
}

const sha256 = (s: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));

/** Constant-time compare. Blank configured token always fails closed. */
export async function qaTokenMatches(
  configured: string | undefined,
  presented: string,
): Promise<boolean> {
  if (!configured) return false;
  if (presented.length > MAX_QA_PRESENTED_TOKEN_LENGTH) return false;
  const [a, b] = await Promise.all([sha256(configured), sha256(presented)]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.min(x.length, y.length); i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

// Pre-authentication guess cap, per client and per isolate, mirroring the
// ops-token attempt bucket (src/admin/ops-overrides.tsx): a presented token
// takes an attempt before the digest comparison and a match refunds it, so
// only failed guesses drain a client. Sustained guessing costs one attempt
// per second after the initial burst; a legitimate holder never nets a
// spend, and one client's flood cannot drain another client's budget.
// DB-free by design — a guess never debits the shared `qa-login` bucket —
// and bounded to QA_MAX_ATTEMPT_CLIENTS entries, evicting the least
// recently seen. Callers answer the existing byte-identical 404 on refusal,
// so exhaustion is indistinguishable from any other failed gate check.
export const QA_ATTEMPT_CAPACITY = 10;
const QA_ATTEMPT_REFILL_PER_SECOND = 1;
const QA_MAX_ATTEMPT_CLIENTS = 1024;
const qaAttempts = new Map<string, { tokens: number; at: number }>();

/** Take one guess attempt for `client`; false when its budget is spent. */
export function takeQaAttempt(client: string, now = Date.now()): boolean {
  const prior = qaAttempts.get(client);
  const tokens = prior
    ? Math.min(
        QA_ATTEMPT_CAPACITY,
        prior.tokens + (Math.max(0, now - prior.at) / 1000) * QA_ATTEMPT_REFILL_PER_SECOND,
      )
    : QA_ATTEMPT_CAPACITY;
  qaAttempts.delete(client);
  if (qaAttempts.size >= QA_MAX_ATTEMPT_CLIENTS)
    qaAttempts.delete(qaAttempts.keys().next().value as string);
  const allowed = tokens >= 1;
  qaAttempts.set(client, { tokens: allowed ? tokens - 1 : tokens, at: now });
  return allowed;
}

/** Return the attempt a matching token just spent, so matches never drain. */
export function refundQaAttempt(client: string): void {
  const bucket = qaAttempts.get(client);
  if (bucket) bucket.tokens = Math.min(QA_ATTEMPT_CAPACITY, bucket.tokens + 1);
}
