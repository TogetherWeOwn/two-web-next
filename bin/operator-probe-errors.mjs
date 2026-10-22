// Refusal-only contract shared by the two offline operator probes. Callers pass
// literal codes, never caught messages, argv, paths, config values or env names.
export const OPERATOR_PROBE_CONTRACT = "docs/operator-probes.md";
export const OPERATOR_PROBE_MAX_INPUT_BYTES = 1_000_000;

const ERRORS = {
  UNKNOWN_OPTION: [
    "Unsupported option or positional argument.",
    "Use --help to select only documented options in --name=value form.",
  ],
  DUPLICATE_OPTION: [
    "An option was supplied more than once.",
    "Use --help and supply each option at most once.",
  ],
  CONFIG_SOURCE_INVALID: [
    "Supply exactly one nonempty --config=<path>.",
    "Set one --config=<path> to a readable local Wrangler JSONC file.",
  ],
  ENV_SOURCE_INVALID: [
    "--env=<name> requires exactly one nonempty --config=<path> and one nonempty environment.",
    "Supply one --config=<path> and one --env=<name>, or omit --env for top-level vars.",
  ],
  CONFIG_UNREADABLE: [
    "Cannot read the Wrangler config file.",
    "Set --config=<path> to a readable local regular file.",
  ],
  CONFIG_TOO_LARGE: [
    "Wrangler config exceeds the 1000000-byte input bound.",
    "Reduce the local --config file to at most 1000000 UTF-8 bytes.",
  ],
  CONFIG_INVALID: [
    "cannot read a valid Wrangler config: expected JSONC configuration objects.",
    "Repair JSONC object structure in the local --config file.",
  ],
  ENV_NOT_FOUND: [
    "unknown environment in config.",
    "Choose an --env=<name> declared in the local config; named vars never inherit.",
  ],
  MODERATOR_VAR_INVALID: [
    "cannot read a valid Wrangler config with a string moderator var.",
    "Set DISCORD_MODERATOR_ROLE_IDS to a string in the selected config vars.",
  ],
  GUILD_VAR_INVALID: [
    "cannot read a valid Wrangler config with a string guild var.",
    "Set DISCORD_GUILD_ID to a string in the selected config vars.",
  ],
  DISCORD_SOURCE_INVALID: [
    "The Discord side requires exactly one nonempty source option.",
    "Supply one --discord-file=<path> or --discord-ids=<csv>, not both; use an empty file for an empty set.",
  ],
  APP_SOURCE_INVALID: [
    "The app side requires exactly one nonempty source option.",
    "Supply one --app-file=<path> or --app-ids=<csv>, not both; use an empty file for an empty set.",
  ],
  DISCORD_FILE_UNREADABLE: [
    "Cannot read the Discord ID file.",
    "Set --discord-file=<path> to a readable local regular file.",
  ],
  APP_FILE_UNREADABLE: [
    "Cannot read the app ID file.",
    "Set --app-file=<path> to a readable local regular file.",
  ],
  DISCORD_INPUT_TOO_LARGE: [
    "Discord input exceeds the 1000000-byte input bound.",
    "Reduce the --discord-file or --discord-ids input to at most 1000000 UTF-8 bytes.",
  ],
  APP_INPUT_TOO_LARGE: [
    "App input exceeds the 1000000-byte input bound.",
    "Reduce the --app-file or --app-ids input to at most 1000000 UTF-8 bytes.",
  ],
  DISCORD_INPUT_INVALID: [
    "Discord input is not a valid list of decimal user IDs.",
    "Fix --discord-file or --discord-ids: use strings of 10-25 decimal digits in JSON, newline text or CSV.",
  ],
  APP_INPUT_INVALID: [
    "App input is not a valid list of decimal user IDs.",
    "Fix --app-file or --app-ids: use strings of 10-25 decimal digits in JSON, newline text or CSV.",
  ],
};

export class ProbeInputError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function emitProbeError(tool, json, code, stderr) {
  const [message, next_action] = ERRORS[code];
  const error = {
    schema: "operator-probe-error.v1",
    tool,
    mode: "error",
    ok: false,
    code,
    message,
    retryable: false,
    next_action,
  };
  stderr(json ? `${JSON.stringify(error)}\n` : `${tool}: ${message} ${next_action}\n`);
  return 2;
}
