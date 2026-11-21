# Event form text and line breaks

Human event create/edit POSTs (`/admin/events` and `/admin/events/:key`),
including the SvelteKit forms that post to those Hono endpoints, use
`parseHumanEventForm`. For title, game, location, organizer display name,
description, accessibility notes and public joining instructions:

- The original submitted string must pass the existing control/invisible-character
  policy, including a BOM that outer trimming would otherwise remove.
- Each CRLF pair and each remaining CR becomes LF. Consecutive breaks, internal
  spaces and tabs, supplementary characters and other accepted code points survive.
- Existing outer trim and empty/null semantics apply. The same canonical value is
  validated and persisted. Limits remain 100/100/255/500/1000/1000/5000 Unicode code
  points respectively; each logical break counts once, not twice as native POST CRLF.
- No truncation, flattening, additional Unicode normalization, migration or read-time
  rewrite occurs. Existing stored CR/CRLF changes representation only when submitted
  through an authorized human save. Exact CR/LF byte identity is not preserved.

The original request-body limits, authorization, date/time carriers, URL policy and
all other fields are unchanged. The named human parser is selected at the editor
route boundary, not by content type. Moderator API create and locked JSON PATCH
merges still use `parseEventForm` with raw code-point/newline accounting; agent
input retains its independent validator. Omitted PATCH fields do not normalize
stored defaults. Explicit blank clears only where the existing full-form/PATCH
contract already permits it; omission is not newly treated as a clear.

## Text-limit island

The progressive text-limit island counts trimmed canonical LF code points, matching
the server. JavaScript is not required for server validation or newline preservation.

## Native controls and verification

Hono and SvelteKit render title, game, location and organizer display name as
two-row textareas only when the stored value or rejected draft contains CR or LF.
Single-line text inputs retain their IDs, labels, hints and errors. Controls do
not switch while typing. If you edit a multiline value down to one line, the
field returns to a text input on the next render. The server preserves accepted
text with or without JavaScript under the rules above.

Textarea values use LF in the browser DOM and `FormData`, but native URL-encoded
form submissions send them as CRLF. The [built-Kit edit proof][browser-proof]
uses a disposable build and submits the native form to the real Hono POST, then
checks disposable Postgres and a fresh Kit GET. It verifies that 1,001 code points
on the wire are accepted when they normalize to 1,000 canonical LF code points,
and that overflow is refused without a write. This fixture does not establish
that the Kit GET is enabled in production; Hono UI gates do not exercise it.

The [first-form test helper][form-helper] models textarea wire CRLF and common
text-input sanitization for inputs and textareas without a submitter. It is not a
full form serializer: selects, external form owners, duplicate-name lists, live
edits, constraint validation and full input-type sanitization and encoding are
out of scope.

[browser-proof]: https://github.com/TogetherWeOwn/two-web-next/pull/2626
[form-helper]: https://github.com/TogetherWeOwn/two-web-next/pull/2581
