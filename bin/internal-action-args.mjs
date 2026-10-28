// Only the documented equals-value form is admitted for value options, and
// only the bare form for flags. Never echo argv: even a refused option can
// contain a credential that belongs in the environment.
//
// Both tools default to an effect-free plan; bare `--dry-run` explicitly
// selects that same plan, while `--apply` selects the existing staging effects.
// `--run-id=<id>` names the run identity a repeated apply resumes under
// (validated by the caller, never echoed). `--json` renders one versioned
// plan/report/error document. Bare `--help` wins over all other input.
export function parseInternalActionArgs(args, smoke = false) {
  const modes = "[--dry-run | --apply] [--json]";
  const announcementUsage = `internal-action-smoke --announcement-only --channel-key=<key> [--run-id=<id>] ${modes}`;
  const usage = `${
    smoke
      ? `Usage: internal-action-smoke --discord-id=<snowflake> --role-key=<key> --channel-key=<key> [--event-key=<key>] [--run-id=<id>] ${modes}\n       ${announcementUsage}`
      : `Usage: internal-action-drill --discord-id=<snowflake> --role-key=<key> --channel-key=<key> [--run-id=<id>] ${modes}`
  }\n\nModes: no mode flag or --dry-run prints an effect-free plan; --apply runs staging effects.\nUse one mode flag at most; flags are bare and value options use --name=value.\n--json prints one versioned plan/report/error document; --help always prints this text,\neven with invalid options or --json, before target, credential or plan validation.\nExits: 0 help, plan or passing checks; 1 failed checks; 2 invalid arguments/configuration.\nProcedure, examples and error-code/next-action reference: docs/bot-probe-staging.md`;
  if (args.includes("--help")) return { help: true, usage };
  const allowed = new Set(["--discord-id", "--role-key", "--channel-key", "--run-id"]);
  if (smoke) allowed.add("--event-key");
  const flags = new Set(["--apply", "--dry-run", "--json"]);
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
  if (seenFlags.has("--dry-run") && seenFlags.has("--apply")) throw new Error(usage);
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
    const modeUsage = announcementOnly ? `Usage: ${announcementUsage}` : usage;
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
