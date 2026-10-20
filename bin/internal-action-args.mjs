// Only the documented equals-value form is admitted. Never echo argv: even a
// refused option can contain a credential that belongs in the environment.
export function parseInternalActionArgs(args, smoke = false) {
  const usage = smoke
    ? "Usage: internal-action-smoke --discord-id=<snowflake> --role-key=<key> --channel-key=<key> [--event-key=<key>]\n       internal-action-smoke --announcement-only --channel-key=<key>"
    : "Usage: internal-action-drill --discord-id=<snowflake> --role-key=<key> --channel-key=<key>";
  const allowed = new Set(["--discord-id", "--role-key", "--channel-key"]);
  if (smoke) allowed.add("--event-key");
  const values = new Map();
  let announcementOnly = false;
  for (const arg of args) {
    if (smoke && arg === "--announcement-only") {
      if (announcementOnly) throw new Error(usage);
      announcementOnly = true;
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(0, equals);
    if (equals < 0 || !allowed.has(name) || values.has(name) || equals === arg.length - 1)
      throw new Error(usage);
    values.set(name, arg.slice(equals + 1));
  }
  const required = announcementOnly
    ? ["--channel-key"]
    : ["--discord-id", "--role-key", "--channel-key"];
  const missing = required.filter((name) => !values.has(name));
  if (missing.length > 0) {
    const modeUsage = announcementOnly
      ? "Usage: internal-action-smoke --announcement-only --channel-key=<key>"
      : usage;
    throw new Error(`missing required option(s): ${missing.join(" ")}\n${modeUsage}`);
  }
  return {
    discordId: values.get("--discord-id"),
    roleKey: values.get("--role-key"),
    channelKey: values.get("--channel-key"),
    eventKey: values.get("--event-key"),
    announcementOnly,
  };
}
