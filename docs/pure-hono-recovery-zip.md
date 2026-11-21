# Pure-Hono recovery ZIP profile

Use `decodePureHonoRecoveryZip` as the [offline validator](../ci/pure-hono-recovery-evidence.mjs)'s `decode` adapter. It returns `{path, bytes, type: "file"}` in central-directory order without extracting or executing anything. The validator checks the manifest and payload inventory separately. Synthetic fixtures do not authenticate evidence or qualify recovery. The route-evidence reader keeps its flat-name profile.

- **Layout:** One disk and a classic, uncommented end record at EOF immediately after the counted central headers. Reference each local record once. Together they must cover byte zero to the central directory without gaps or overlaps, in any order.
- **Encoding:** STORE (0) or raw DEFLATE (8), flags `0` or `0x0800` (UTF-8), creator `0x0314` (Unix ZIP 2.0), version needed `20` (`10` also works for STORE).
  External attributes carry a Unix regular-file mode in the high word (e.g. octal `0100644`), with only `0777` permission bits and a zero low word. Internal attributes are zero.
- **Agreement:** Local and central headers match on name bytes, version needed, flags, method, DOS timestamp bytes, CRC-32 and both sizes. No extras, comments, descriptors, ZIP64, encryption, directory entries, links or special files. Compressed input consumption, decoded size and CRC-32 must match the headers.
- **Paths:** `manifest.json`, `worker.js`, `effective-config.json`, or a file under `assets/`. Maximum 512 bytes and 32 `/`-separated components. Use only ASCII letters, digits, `.`, `_` and `-` in nonempty components; never end a component with `.`.
  Exclude DOS device stems (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9`), even before extensions. No duplicates, case-folded aliases (including implicit directories), or paths that are both files and implicit directories.
- **Limits:** 64 MiB archive, 4,097 members including the manifest, 128 MiB expanded per member and total, 1 MiB manifest, 100:1 expanded-to-compressed ratio per member.
  Zero compressed bytes require zero expanded bytes. Use STORE when DEFLATE exceeds the ratio cap. Fail the archive if a payload cannot fit; never omit, rename or truncate members.
