export type Env = {
  APP_URL: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_GUILD_ID: string;
  DISCORD_INVITE_URL: string;
  // Secrets (wrangler secret put). The bot token must belong to the same Discord application as
  // DISCORD_CLIENT_ID: Discord only lets an application's own bot add a member with that
  // application's guilds.join token.
  DISCORD_CLIENT_SECRET: string;
  DISCORD_BOT_TOKEN: string;
  SESSION_SECRET: string;
};

export type Session = {
  id: string;
  username: string;
  avatar: string | null;
  member: boolean;
  exp: number;
};
