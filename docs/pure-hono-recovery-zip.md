# Pure-Hono recovery ZIP profile

The [offline validator](../ci/pure-hono-recovery-evidence.mjs) accepts
`decodePureHonoRecoveryZip` as its `decode` adapter. It returns `{path, bytes,
type: "file"}` records in central-directory order without extracting or
executing anything. Writers must emit this ZIP subset:

- One disk; a classic, uncommented end record at EOF immediately preceded by
  exactly the counted central headers. Every local record is referenced once.
  The records cover byte zero to the central directory with no gaps or overlaps;
  they need not be in central-directory order.
- STORE (method 0) or raw DEFLATE (method 8). Flags are `0` or `0x0800` (UTF-8);
  names must be ASCII either way. Use creator `0x0314` (Unix ZIP 2.0) and version
  needed `20` (or `10` for STORE). External attributes are a Unix regular-file
  mode in the high word (for example `0100644` in octal), with only `0777`
  permission bits and a zero low word. Internal attributes are zero.
- Local and central headers agree on name bytes, version needed, flags, method,
  DOS timestamp bytes, CRC-32 and both sizes. Include no extra fields, comments,
  data descriptors, ZIP64, encryption, directory entries, links or special files.
  The compressed payload must consume exactly its declared bytes; decoded size
  and CRC-32 must match. Use STORE if DEFLATE would exceed the ratio limit.
- Use exact root names `manifest.json`, `worker.js`, `effective-config.json`, or a
  file path below `assets/`. Paths are at most 512 bytes and 32 `/`-separated
  components. Components use ASCII letters, digits, `.`, `_` and `-`, are
  nonempty and cannot end in `.`. DOS device stems (`CON`, `PRN`, `AUX`, `NUL`,
  `COM0`–`COM9`, `LPT0`–`LPT9`) are excluded, including before an extension.
  Do not use duplicates, case-folded aliases (even for implicit directories),
  or a path that is both a file and an implicit directory.
- Limits: 64 MiB archive, 4,097 members including the manifest, 128 MiB expanded
  per member and in aggregate, 1 MiB for `manifest.json`, and at most 100:1
  expanded-to-compressed bytes per member. A zero compressed size is allowed
  only for zero expanded bytes. If a payload does not fit this profile, fail the
  archive rather than omitting, renaming or truncating a member.

The validator separately checks the manifest and payload inventory. Synthetic
fixtures do not authenticate evidence or qualify recovery. The route-evidence
reader keeps its separate flat-name profile.
