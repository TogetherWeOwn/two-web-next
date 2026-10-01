export function discordWidgetUrl(guildId: string | undefined): string | null {
  return typeof guildId === "string" && /^\d{10,25}$/.test(guildId)
    ? `https://discord.com/widget?id=${guildId}&theme=dark`
    : null;
}
