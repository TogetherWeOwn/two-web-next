# Offline operator probes

Use Node 22.23.0+ on the 22.x line, or 24+. These tools compare supplied local
configuration or ID lists. They never query Discord, open a database, mutate
roles or files, or read service credentials. A config verdict is not evidence
of live configuration, deployment or environment isolation.

| Tool ID | Invocation | Purpose |
| --- | --- | --- |
| `check-moderators` | `node --import ./bin/ts-hook.mjs bin/check-moderators.mjs` | Validate moderator-role configuration and guild binding. |
| `role-audit` | `node --import ./bin/ts-hook.mjs bin/role-audit.mjs` | Compare operator-supplied Discord and app user-ID sets. |

Append `--help` for bounded usage on stdout, exit 0 and no input reads. Help
wins over all other arguments, including `--json` and invalid options. Supply
each option at most once, with values in `--name=value` form. Unknown options,
positional arguments, duplicate options and ambiguous sources are refused.

## Inputs

`check-moderators` accepts `--require-configured`, `--json`,
`--config=<path>` and `--env=<name>`. Without a file it uses the process variables
`DISCORD_MODERATOR_ROLE_IDS` and `DISCORD_GUILD_ID`. A file is Wrangler JSONC:
`--config` reads only top-level `vars`; adding `--env` reads only that declared
named environment's `vars`, with **no fallback** to top-level or process values.
Environment lookup uses declared own keys, not object-prototype properties.
Config, selected environment and present `vars` must be objects. Present role
and guild variables must be strings. Missing or blank values remain findings,
not parse errors. `--require-configured` with a file also requires a recognized
guild and its exact approved pair. Blank process configuration without that
flag remains a valid local revocation state.

`role-audit` requires one nonempty `--discord-file=<path>` **or**
`--discord-ids=<csv>`, and one nonempty `--app-file=<path>` **or**
`--app-ids=<csv>`. Files contain a JSON array of strings or newline/comma-separated
text. A blank file or `[]` means an empty set; an empty option is not a source.
IDs are strings of 10–25 decimal digits. Whitespace and blank entries are dropped;
IDs are deduplicated and sorted before comparison. Neither source is opened
until both source selections are unambiguous.

File inputs must be local regular files; directories, FIFOs and devices are
refused before reading. Each config file and each role-audit input is limited
to 1,000,000 UTF-8 bytes before parsing/comparison. Files reporting over the
bound are refused before reading; a post-decode byte check still covers inline
CSV and UTF-8 replacement expansion. Role-audit
verdicts show at most 20 IDs per difference list, with exact counts of omitted
IDs. Valid comparison output intentionally includes those user IDs; refusals
never include rejected values.

## Streams and exits

| Exit | Meaning | stdout | stderr |
| --- | --- | --- | --- |
| 0 | Help, passing moderator findings, or matching ID sets (including both empty) | Usage or verdict | Empty |
| 1 | Failed moderator findings or differing ID sets | Verdict | Empty |
| 2 | Usage or input refusal; no comparison verdict | Empty | One static human message, or exactly one JSON error document with `--json` |

Existing human verdicts and successful/failed-comparison JSON shapes are
unchanged. A moderator verdict is `{results, failures, unknowns, ok}`; a role-audit
verdict is `{ok, discordCount, appCount, discordOnly, appOnly}`, with difference
lists shaped as `{shown, omitted}`. Exit 1 with `ok:false` is a completed
comparison, **not** a usage/input error. No success schema fields are added.

## Error contract: operator-probe-error.v1

With `--json`, parse the **entire stderr stream** as one JSON document on exit 2;
stdout is empty. The document has exactly these fields:

| Field | Meaning |
| --- | --- |
| `schema` | Literal `operator-probe-error.v1`; the versioned refusal schema ID. |
| `tool` | Stable tool ID from the invocation table. |
| `mode` | Literal `error`; never a comparison verdict. |
| `ok` | Literal `false`. |
| `code` | Stable UPPER_SNAKE classification from the table below. |
| `message` | Static safe summary, not rejected input or raw exception text. |
| `retryable` | Literal `false`: repair the input before rerunning, not automatic retries. |
| `next_action` | Specific static repair instruction naming the relevant option or variable. |

Example, identically classified regardless of the rejected option's contents:

```json
{"schema":"operator-probe-error.v1","tool":"role-audit","mode":"error","ok":false,"code":"UNKNOWN_OPTION","message":"Unsupported option or positional argument.","retryable":false,"next_action":"Use --help to select only documented options in --name=value form."}
```

The implementation vocabulary and emitter live in
[`bin/operator-probe-errors.mjs`](../bin/operator-probe-errors.mjs). Human and JSON
refusals use the same static message and action. No argv, paths, environment-name
input, file contents, variable values, OS diagnostics or parse exception text
are interpolated. Field meanings and codes do not alias HTTP, erase/revoke or
other CLI contracts. New incompatible meanings require a new schema version.

| Code | Tool | Meaning / repair |
| --- | --- | --- |
| `UNKNOWN_OPTION` | Both | Unsupported argument; select documented options with `--help`. |
| `DUPLICATE_OPTION` | Both | Repeated boolean option; supply each option once. |
| `CONFIG_SOURCE_INVALID` | check-moderators | Empty/repeated config option; supply one nonempty `--config`. |
| `ENV_SOURCE_INVALID` | check-moderators | Empty/repeated environment or missing/ambiguous config; supply one of each or omit `--env`. |
| `CONFIG_UNREADABLE` | check-moderators | Config file cannot be read; choose a readable local file. |
| `CONFIG_TOO_LARGE` | check-moderators | Config exceeds the byte bound; reduce it. |
| `CONFIG_INVALID` | check-moderators | Malformed JSONC or invalid object structure; repair the config. |
| `ENV_NOT_FOUND` | check-moderators | Named environment is not declared; choose a declared `--env`. |
| `MODERATOR_VAR_INVALID` | check-moderators | Present role variable is not a string; fix the selected vars. |
| `GUILD_VAR_INVALID` | check-moderators | Present guild variable is not a string; fix the selected vars. |
| `DISCORD_SOURCE_INVALID` | role-audit | Missing, empty, duplicate or conflicting Discord sources; choose one file or CSV option. |
| `APP_SOURCE_INVALID` | role-audit | Missing, empty, duplicate or conflicting app sources; choose one file or CSV option. |
| `DISCORD_FILE_UNREADABLE` | role-audit | Discord file cannot be read; repair `--discord-file`. |
| `APP_FILE_UNREADABLE` | role-audit | App file cannot be read; repair `--app-file`. |
| `DISCORD_INPUT_TOO_LARGE` | role-audit | Discord input exceeds the byte bound; reduce its file/CSV. |
| `APP_INPUT_TOO_LARGE` | role-audit | App input exceeds the byte bound; reduce its file/CSV. |
| `DISCORD_INPUT_INVALID` | role-audit | Malformed JSON, invalid element types or nondecimal IDs; repair Discord file/CSV. |
| `APP_INPUT_INVALID` | role-audit | Malformed JSON, invalid element types or nondecimal IDs; repair app file/CSV. |

## Safe offline examples and AX evidence

Use synthetic fixtures only, never a service token or real member export:

```sh
# Matching synthetic lists: exit 0, unchanged verdict on stdout.
node --import ./bin/ts-hook.mjs bin/role-audit.mjs \
  --discord-ids=100000000000000001 --app-ids=100000000000000001 --json

# No file is opened: exit 2, safe versioned error on stderr, stdout empty.
node --import ./bin/ts-hook.mjs bin/check-moderators.mjs --unknown=SYNTHETIC_ARGV_MARKER --json
node --import ./bin/ts-hook.mjs bin/role-audit.mjs --unknown=SYNTHETIC_ARGV_MARKER --json

# Reads a local synthetic JSONC fixture only, not any deployed configuration.
# Fixture contents: {"vars":{},"env":{"fixture":{"vars":{}}}}
node --import ./bin/ts-hook.mjs bin/check-moderators.mjs \
  --config=./fixture.jsonc --env=fixture --json

npx vitest run test/operator-probe-refusals-acceptance.test.ts \
  test/operator-probe-errors.test.ts test/probes.test.ts test/role-audit.test.ts
```

The acceptance suite pins schema/tool IDs, exact error fields, nonretryable and
actionable repairs, both stream owners, 0/1/2 exits and nonreflection with two
sentinels. Refusals are at most 1,024 bytes; each help is at most 3,072 bytes and
links this contract (at most 12,288 bytes). Child-only network and filesystem
mutation tripwires record attempted effects even if caught: both counters must
stay zero. Controls pin unchanged human verdict bytes, JSON shapes, guild
binding, no config fallback and bounded drift output. Supplemental tests pin
the documented code taxonomy and UTF-8 byte bounds. This is offline evidence,
not a live-role or deployment receipt.

`--dry-run` and replay IDs are **N/A**, not undocumented modes: these comparisons
already have no network, database or mutation operation to preview or replay.
They are rejected as unknown options. Do not add live modes to demonstrate safety.
