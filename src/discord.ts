// Minimal Discord OAuth2 + guild auto-join. No SDK: three HTTP calls, all typed here.
import { discordFetch } from "./discord-http";
import { MAX_RETRY_DELAY_SECONDS } from "./jobs/retry-delay";
const API = "https://discord.com/api/v10";

// identify: who they are. guilds.join: lets our bot add them to the TWO server in one click.
export const SCOPES = ["identify", "guilds.join"] as const;

export type DiscordUser = {
  id: string;
  username: string;
  global_name: string | null;
  avatar: string | null;
};

// Documented bounds for provider identity values carried into session and
// roster rows. Discord user ids are decimal snowflakes (positive ASCII digits,
// 1-20 characters, no leading zero); usernames and display names stay well
// under 128 characters and avatar hashes under 512 in practice; anything
// longer or non-decimal is a hostile or broken provider payload, not a
// member. Oversized or non-snowflake values are rejected (never truncated,
// coerced, trimmed or rewritten) in fetchUser before any session or roster
// write, so both callbacks keep their existing generic failure outcome.
// Only the value shape is inspected — values are never logged, echoed, or stored.
export const DISCORD_USERNAME_MAX_LENGTH = 128;
export const DISCORD_DISPLAY_NAME_MAX_LENGTH = 128;
export const DISCORD_AVATAR_MAX_LENGTH = 512;

// Positive ASCII-decimal snowflake admission: 1-20 digits, first digit 1-9.
// No multiline flag; the raw provider value is tested as-is (no coerce,
// trim, truncate or substitute), so hostile ids fail into the existing
// provider_reject path before any guild/member/role egress or write.
const DISCORD_USER_ID_RE = /^[1-9][0-9]{0,19}$/;

export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    scope: SCOPES.join(" "),
    redirect_uri: redirectUri,
    state,
  });
  return `https://discord.com/oauth2/authorize?${q}`;
}

// ---------------------------------------------------------------------------
// Bounded failure classification (TOG-10355).
//
// Ports the legacy JoinController / DiscordLoginController contract: what the
// member is told — and what the log records — depends on the HTTP status and,
// only for a 4xx, on Discord's own machine `error` code. The error body is read
// once here and reduced to that whitelisted code; its text (which can quote the
// client secret or the live access token) never leaves this module, and every
// thrown DiscordError carries a fixed message. Status governs: a 5xx whose body
// happens to say `invalid_grant` is an outage, not an expired approval — only
// 400 + invalid_grant means "try again right now" (legacy JoinCallbackFailureTest).
// ---------------------------------------------------------------------------

/** Machine-readable failure class. Logged by name; never with a message. */
export type DiscordFailureKind =
  | "expired_grant" // 400 + `error: invalid_grant` — the approval was spent, replayed or timed out
  | "provider_reject" // any other 4xx (invalid_client, unparseable body, missing token field, ...)
  | "rate_limited" // 429
  | "provider_outage" // 5xx — the status governs even when the body says invalid_grant
  | "transport_failure"; // fetch itself threw (DNS, timeout, connection reset)

export class DiscordError extends Error {
  readonly providerCode: string | null;
  readonly retryAfter: number | undefined;
  constructor(
    readonly step: string,
    readonly status: number,
    readonly kind: DiscordFailureKind,
    providerCode: string | null = null,
    retryAfter?: number,
  ) {
    super(`discord ${step} failed with HTTP ${status}`);
    this.providerCode = providerCode;
    // Bounded integer delta-seconds from a 429's `retry-after` header, for
    // callers that surface provider backoff (join recovery). Undefined unless
    // a usable 429 backoff was present: never a body value, never raw text.
    this.retryAfter = retryAfter;
    this.name = "DiscordError";
  }
}

// The only provider codes that change what the member is told. The whitelist
// keeps a hostile or creative body from shaping our UX; anything else degrades
// to provider_reject (generic failure copy).
const PROVIDER_CODES = new Set([
  "invalid_grant",
  "invalid_client",
  "invalid_request",
  "unauthorized_client",
  "access_denied",
]);

/**
 * Extract Discord's machine error code from a response body, defensively:
 * parse failures, non-object bodies and unknown codes all yield null. The
 * `error_description` field is never read — it echoes member-supplied input.
 */
function providerCodeOf(status: number, body: string): string | null {
  if (status >= 500 || status === 429) return null; // status governs; the body is not consulted
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const code = (parsed as { error?: unknown }).error;
  return typeof code === "string" && PROVIDER_CODES.has(code) ? code : null;
}

function kindOf(status: number, providerCode: string | null): DiscordFailureKind {
  if (status >= 500) return "provider_outage";
  if (status === 429) return "rate_limited";
  if (status === 400 && providerCode === "invalid_grant") return "expired_grant";
  return "provider_reject";
}

/** The error body, read defensively: text only, capped, never throws. */
async function errorBodyOf(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 2048);
  } catch {
    return "";
  }
}

/**
 * Bounded `retry-after` seconds from a 429 response, for callers that surface
 * provider backoff as a `Retry-After` header. Same numeric-only parse style as
 * `src/events/discord-transients-live.ts` (trimmed digits with an optional
 * fraction, finite and representable — no HTTP dates, signs, exponents, units
 * or markup), then the `src/jobs/retry-delay.ts` admission posture: fractions
 * round UP so the client never retries sooner than the provider asked, values
 * below 1s are unusable, and representable-but-absurd values cap at the
 * largest admitted delay instead of echoing raw. Anything unusable yields
 * undefined so the caller falls back to today's headerless response.
 */
function providerRetryAfterSeconds(res: Response): number | undefined {
  // `Number(null)` and `Number("")` are 0: an absent header must not read as backoff.
  const raw = res.headers.get("retry-after")?.trim();
  if (!raw || !/^\d+(?:\.\d+)?$/.test(raw)) return undefined;
  const n = Number(raw);
  // Only representable numeric delays are valid; no HTTP dates or infinity.
  if (!Number.isFinite(n) || n * 1000 > 8_000_000_000_000_000) return undefined;
  const seconds = Math.ceil(n);
  if (seconds < 1) return undefined;
  return Math.min(seconds, MAX_RETRY_DELAY_SECONDS);
}

function classified(step: string, res: Response, body: string): DiscordError {
  const providerCode = providerCodeOf(res.status, body);
  const kind = kindOf(res.status, providerCode);
  // Only 429 backoff flows through: any other status keeps today's headerless
  // response even when the provider sent a `retry-after` header.
  const retryAfter = kind === "rate_limited" ? providerRetryAfterSeconds(res) : undefined;
  return new DiscordError(step, res.status, kind, providerCode, retryAfter);
}

/** Wrap a transport throw the same way: bounded class, no raw message. */
function transportFailure(step: string): DiscordError {
  return new DiscordError(step, 0, "transport_failure");
}

/**
 * The bounded facts a route may log about a caught Discord failure: the class
 * name, the kind, and the HTTP status. Never a message, never a body.
 */
export function failureMeta(err: unknown): {
  exception: string;
  kind: DiscordFailureKind | "unknown";
  status: number | null;
} {
  if (err instanceof DiscordError)
    return { exception: err.name, kind: err.kind, status: err.status };
  return {
    exception: (err as { constructor?: { name?: string } })?.constructor?.name ?? "unknown",
    kind: "unknown",
    status: null,
  };
}

/** True when the failure is Discord-side or on the wire — retry in a minute, not "you cancelled". */
export function isProviderOutage(kind: DiscordFailureKind | "unknown"): boolean {
  return kind === "provider_outage" || kind === "transport_failure" || kind === "rate_limited";
}

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string> {
  let res: Response;
  try {
    res = await discordFetch(`${API}/oauth2/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch {
    throw transportFailure("token_exchange");
  }
  if (!res.ok) throw classified("token_exchange", res, await errorBodyOf(res));
  const body: unknown = await res.json().catch(() => null);
  const token = body as { access_token?: unknown } | null;
  if (
    token === null ||
    typeof token !== "object" ||
    Array.isArray(token) ||
    typeof token.access_token !== "string" ||
    !token.access_token
  ) {
    throw new DiscordError("token_exchange", res.status, "provider_reject");
  }
  return token.access_token;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  let res: Response;
  try {
    res = await discordFetch(`${API}/users/@me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw transportFailure("fetch_user");
  }
  if (!res.ok) throw classified("fetch_user", res, await errorBodyOf(res));
  // A successful status does not guarantee a usable identity. Keep parse/read
  // failures and malformed fields inside the callbacks' bounded recovery path.
  const body: unknown = await res.json().catch(() => null);
  const user = body as Partial<DiscordUser> | null;
  if (
    user === null ||
    typeof user !== "object" ||
    Array.isArray(user) ||
    typeof user.id !== "string" ||
    !user.id ||
    typeof user.username !== "string" ||
    !user.username ||
    (user.global_name !== null && typeof user.global_name !== "string") ||
    (user.avatar !== null && typeof user.avatar !== "string")
  ) {
    throw new DiscordError("fetch_user", res.status, "provider_reject");
  }
  // Bound identity lengths before any session or roster write. Rejection
  // keeps the callbacks' existing bounded provider_reject path: no session
  // cookie, no roster statement, no further Discord calls, and the fixed
  // error carries no provider bytes.
  if (
    user.username.length > DISCORD_USERNAME_MAX_LENGTH ||
    (typeof user.global_name === "string" &&
      user.global_name.length > DISCORD_DISPLAY_NAME_MAX_LENGTH) ||
    (typeof user.avatar === "string" && user.avatar.length > DISCORD_AVATAR_MAX_LENGTH)
  ) {
    throw new DiscordError("fetch_user", res.status, "provider_reject");
  }
  // Bound the provider user id before any session or roster write. Rejection
  // keeps the callbacks' existing bounded provider_reject path: no session
  // cookie, no roster statement, no further Discord calls, and the fixed
  // error carries no provider bytes.
  if (!DISCORD_USER_ID_RE.test(user.id)) {
    throw new DiscordError("fetch_user", res.status, "provider_reject");
  }
  return user as DiscordUser;
}

export type JoinResult =
  | "joined"
  | "already_member"
  | "rate_limited"
  | "forbidden"
  | "provider_outage"
  | "transport_failure"
  | "failed";

// PUT /guilds/{guild}/members/{user}: 201 = added, 204 = already a member.
// Failures are classified by status alone so callers can distinguish them
// without reading the provider body: 429 = rate_limited, 403 = forbidden
// (Missing Access / Missing Permissions class), 5xx = provider_outage, a
// transport throw = transport_failure, anything else = failed. The body is
// never read and never logged here, so no token or body byte can leak through
// the return value; every value is a fixed string. A transport throw is
// "transport_failure" too: the caller degrades to the invite link either way.
//
// A 429 may carry a bounded `retryAfter` (delta-seconds from the response's
// `retry-after` header, same admission as DiscordError.retryAfter): present
// only when the header is usable (trimmed digits with an optional fraction,
// rounded up, minimum 1, capped at 86400). Absent, malformed, body-only or
// non-429 values yield no backoff. The plain `addGuildMember` wrapper keeps
// the historical string-only contract; callers that surface provider backoff
// use the detailed form.
export type GuildMemberAdd = {
  result: JoinResult;
  retryAfter?: number;
};

export async function addGuildMemberDetailed(
  guildId: string,
  userId: string,
  accessToken: string,
  botToken: string,
): Promise<GuildMemberAdd> {
  // Fail closed on an unconfigured bot token (TOG-12687): a blank token must
  // emit zero bot-credentialed calls, so the callers degrade to the invite
  // fallback instead of sending `Bot ` with nothing after it.
  if (!botToken || botToken.trim().length === 0) return { result: "failed" };
  let res: Response;
  try {
    res = await discordFetch(`${API}/guilds/${guildId}/members/${userId}`, {
      method: "PUT",
      headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch {
    return { result: "transport_failure" };
  }
  if (res.status === 201) return { result: "joined" };
  if (res.status === 204) return { result: "already_member" };
  if (res.status === 429) {
    const retryAfter = providerRetryAfterSeconds(res);
    return retryAfter === undefined
      ? { result: "rate_limited" }
      : { result: "rate_limited", retryAfter };
  }
  if (res.status === 403) return { result: "forbidden" };
  if (res.status >= 500 && res.status <= 599) return { result: "provider_outage" };
  return { result: "failed" };
}

export async function addGuildMember(
  guildId: string,
  userId: string,
  accessToken: string,
  botToken: string,
): Promise<JoinResult> {
  return (await addGuildMemberDetailed(guildId, userId, accessToken, botToken)).result;
}
