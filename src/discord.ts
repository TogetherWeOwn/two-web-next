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

export async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string> {
  const res = await discordFetch(`${API}/oauth2/token`, {
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
  if (!res.ok) throw new DiscordError("token_exchange", res.status);
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new DiscordError("token_exchange", res.status);
  return body.access_token;
}

export async function fetchUser(accessToken: string): Promise<DiscordUser> {
  const res = await discordFetch(`${API}/users/@me`, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new DiscordError("fetch_user", res.status);
  return (await res.json()) as DiscordUser;
}

export type JoinResult = "joined" | "already_member" | "failed";

// PUT /guilds/{guild}/members/{user}: 201 = added, 204 = already a member.
// Anything else (bot missing CREATE_INSTANT_INVITE, user banned, member cap) is "failed": the
// sign-in still succeeds and the page offers the invite link instead.
export async function addGuildMember(
  guildId: string,
  userId: string,
  accessToken: string,
  botToken: string,
): Promise<JoinResult> {
  const res = await discordFetch(`${API}/guilds/${guildId}/members/${userId}`, {
    method: "PUT",
    headers: { authorization: `Bot ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
  });
  if (res.status === 201) return "joined";
  if (res.status === 204) return "already_member";
  return "failed";
}

export class DiscordError extends Error {
  constructor(
    readonly step: string,
    readonly status: number,
  ) {
    super(`discord ${step} failed with HTTP ${status}`);
  }
}
