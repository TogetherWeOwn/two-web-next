# Event form text and native line breaks

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

## Controls and feedback

Title, game, location and organizer use the existing single-line input unless the
rendered stored value or error draft contains CR or LF. In that case a native
`textarea rows=2` preserves visible text and line positions. Both renderers use
`eventTextHasLineBreak`, existing labels, field IDs, hints, error associations and
textarea styling. Ordinary events are visually unchanged. There is no hidden
original-text carrier or keystroke-driven control switch. Removing all breaks
changes the control back to an input only on the next server render.

The progressive text-limit island counts trimmed canonical LF code points, matching
the server. No native UTF-16 `maxlength` prevents otherwise accepted astral text.
JavaScript is not required for server validation or newline preservation.

## Evidence and fixture limits

The native event browser suite captures DOM FormData separately from actual native
URL-encoded POST requests. Textarea DOM values/FormData contain LF; wire values use
CRLF. At a 1000 limit, 998 `x` + break + `y` is accepted and 999 `x` + break + `y`
is refused after canonicalization. Parser, route persistence, client feedback and
rendered controls have separate tests; a pure HTML helper is not browser evidence.

`test/helpers/kit-edit-controls.ts` builds on the input/textarea fixture helper in
[the Kit edit field-preservation change](https://github.com/TogetherWeOwn/two-web-next/pull/2110).
This follow-up does not modify that PR's head. Its `submittedFields` output models
native textarea CRLF and common text-input newline sanitation for the first form,
without a submitter. It is deliberately not a complete successful-controls or
HTML serialization implementation: selects, external form owners, duplicate-name
lists, live editing, constraint validation and complete input-type rules/encoding
are outside its fidelity. Browser requests remain the wire oracle.
