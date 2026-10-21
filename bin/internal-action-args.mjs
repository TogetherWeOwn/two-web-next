// Only the documented equals-value form is admitted for value options, and
// only the bare form for flags. Never echo argv: even a refused option can
// contain a credential that belongs in the environment.
//
// Both tools default to an effect-free plan; the bare `--apply` flag selects
// the existing staging effects. `--run-id=<id>` names the run identity a
// repeated apply resumes under (validated by the caller, never echoed).
// `--json` renders the plan, report or error as one versioned JSON document.
export function parseInternalActionArgs(args, smoke = false) {
  const usage = smoke
    ? "Usage: internal-action-smoke --discord-id=<snowflake> --role-key=<key> --channel-key=<key> [--event-key=<key>] [--run-id=<id>] [--apply] [--json]\n       internal-action-smoke --announcement-only --channel-key=<key> [--run-id=<id>] [--apply] [--json]"
    : "Usage: internal-action-drill --discord-id=<snowflake> --role-key=<key> --channel-key=<key> [--run-id=<id>] [--apply] [--json]";
  const allowed = new Set(["--discord-id", "--role-key", "--channel-key", "--run-id"]);
  if (smoke) allowed.add("--event-key");
  const flags = new Set(["--apply", "--json"]);
  if (smoke) flags.add("--announcement-only");
  const seenFlags = new Set();
  const values = new Map();
  for (const arg of args) {
    if (flags.has(arg)) {
      if (seenFlags.has(arg)) throw new Error(usage);
      seenFlags.add(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const name = arg.slice(0, equals);
    if (equals < 0 || !allowed.has(name) || values.has(name) || equals === arg.length - 1)
      throw new Error(usage);
    values.set(name, arg.slice(equals + 1));
  }
  const announcementOnly = seenFlags.has("--announcement-only");
  if (announcementOnly) {
    const contradictions = ["--discord-id", "--role-key", "--event-key"].filter((name) =>
      values.has(name),
    );
    if (contradictions.length > 0) {
      throw new Error(
        `contradictory options: --announcement-only cannot be combined with ${contradictions.join(", ")}\n${usage}`,
      );
    }
  }
  const required = announcementOnly
    ? ["--channel-key"]
    : ["--discord-id", "--role-key", "--channel-key"];
  const missing = required.filter((name) => !values.has(name));
  if (missing.length > 0) {
    const modeUsage = announcementOnly
      ? "Usage: internal-action-smoke --announcement-only --channel-key=<key> [--run-id=<id>] [--apply] [--json]"
      : usage;
    throw new Error(`missing required option(s): ${missing.join(" ")}\n${modeUsage}`);
  }
  return {
    discordId: values.get("--discord-id"),
    roleKey: values.get("--role-key"),
    channelKey: values.get("--channel-key"),
    eventKey: values.get("--event-key"),
    runId: values.get("--run-id"),
    announcementOnly,
    apply: seenFlags.has("--apply"),
    json: seenFlags.has("--json"),
  };
}
