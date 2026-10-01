// Minimal Discord OAuth2 + guild auto-join. No SDK: three HTTP calls, all typed here.
import { discordFetch } from "./discord-http";
const API = "https://discord.com/api/v10";

// identify: who they are. guilds.join: lets our bot add them to the TWO server in one click.
export const SCOPES = ["identify", "guilds.join"] as const;

export type DiscordUser = { id: string; username: string; global_name: string | null; avatar: string | null };

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
  constructor(
    readonly step: string,
    readonly status: number,
    readonly kind: DiscordFailureKind,
    providerCode: string | null = null,
  ) {
    super(`discord ${step} failed with HTTP ${status}`);
    this.providerCode = providerCode;
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

function classified(step: string, res: Response, body: string): DiscordError {
  const providerCode = providerCodeOf(res.status, body);
  return new DiscordError(step, res.status, kindOf(res.status, providerCode), providerCode);
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
  if (err instanceof DiscordError) return { exception: err.name, kind: err.kind, status: err.status };
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
    token === null || typeof token !== "object" || Array.isArray(token) ||
    typeof token.access_token !== "string" || !token.access_token
  ) {
    throw new DiscordError("token_exchange", res.status, "provider_reject");
  }
  return token.access_token;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  let res: Response;
  try {
    res = await discordFetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } });
  } catch {
    throw transportFailure("fetch_user");
  }
  if (!res.ok) throw classified("fetch_user", res, await errorBodyOf(res));
  // A successful status does not guarantee a usable identity. Keep parse/read
  // failures and malformed fields inside the callbacks' bounded recovery path.
  const body: unknown = await res.json().catch(() => null);
  const user = body as Partial<DiscordUser> | null;
  if (
    user === null || typeof user !== "object" || Array.isArray(user) ||
    typeof user.id !== "string" || !user.id ||
    typeof user.username !== "string" || !user.username ||
    (user.global_name !== null && typeof user.global_name !== "string") ||
    (user.avatar !== null && typeof user.avatar !== "string")
  ) {
    throw new DiscordError("fetch_user", res.status, "provider_reject");
  }
  return user as DiscordUser;
}

export type JoinResult = "joined" | "already_member" | "failed";

// PUT /guilds/{guild}/members/{user}: 201 = added, 204 = already a member.
// Anything else (bot missing CREATE_INSTANT_INVITE, user banned, member cap) is "failed": the
// sign-in still succeeds and the page offers the invite link instead. A transport
// throw is "failed" too: the caller degrades to the invite link either way.
export async function addGuildMember(
  guildId: string,
  userId: string,
  accessToken: string,
  botToken: string,
): Promise<JoinResult> {
  let res: Response;
  try {
    res = await discordFetch(`${API}/guilds/${guildId}/members/${userId}`, {
      method: "PUT",
      headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });
  } catch {
    return "failed";
  }
  if (res.status === 201) return "joined";
  if (res.status === 204) return "already_member";
  return "failed";
}
