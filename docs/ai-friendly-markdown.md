# AI-friendly Markdown: inert event text

Event-authored `title`, `game`, `location`, `description`, organizer name and
join instructions render inside the machine Markdown documents (`/events.md`,
`/e/:key.md`, the 410 gone body) through one helper, `mdText` in
`src/ai-friendly/md.ts`. The public join URL rides the detail `- Join:` line
as inert `\[url\](url)`-shaped text: agents read the exact stored destination,
while the escaped label brackets stop any CommonMark reader forming a link
node. The contract: author text can never form an HTML, link (including
autolink) or image node when a CommonMark reader parses those documents, while
server-owned links, headings, status lines and event-key identities survive
byte-for-byte on healthy input.

## Escaping rules

`mdText` applies context-free escapes in this order:

1. Backslash to `\\`, so later escapes stay literal.
2. `[` and `]` to `\[` and `\]`, so link and image labels cannot form.
3. `<` to `\<`, so tags, comments and angle autolinks cannot open. Every
   inline HTML/autolink node opens with `<`, including the `</div>` closer the
   old line-prefix escaping missed.
4. CR/CRLF to LF, then a `\` prefix on any line that still opens a block
   (headings, quotes, lists, fences, setext underlines, indented code).

Deliberately untouched: `&` (entities expand after tag parsing, so `&lt;`
stays text while `AT&T` stays byte-identical), emphasis and code-span
delimiters (they form no HTML/link/image nodes), and all Unicode prose.
`mdInlineText` additionally folds newlines to spaces so titles, game and
location stay on one heading/row line.

## What stays stable

- List: `# Upcoming events at Together We Own`, one `## [title](event-url)`
  per row, `- When:`, `- Game:`, `- Where:`, `- Host:`, `- Markdown:` rows.
  No `- Join:` line ever appears in list rows.
- Detail: `# title`, `- Status:`, `- Starts:`, `- Ends:`, `- Host:`,
  `- Join:`, `## About this event`, `[Add to calendar (.ics)]` and `[See
  upcoming events]` links.
- Gone: `# title`, the `Cancelled` notice, `[See upcoming events]`.
- Event keys appear only inside server-built canonical, event, calendar and
  Markdown-alternate URLs. The one author URL — the detail `- Join:` line —
  sits in inert `\[url\](url)` text, never in a live link destination.
- Privacy: public fields only. No attendee, RSVP, waitlist or raw Discord
  identity ever enters these builders.

## Agent-runnable check

Pure builders, no database or network:

```sh
npx vitest run test/ai-friendly-md-inert-acceptance.test.ts
npx vitest run test/ai-friendly-md-host-join-acceptance.test.ts
```

`test/ai-friendly-md-inert-acceptance.test.ts` pins 36 cases through a
CommonMark-subset inline scanner (`authorControlledNodes`). Explicit failure
cases: inline `<img>`, `<script>`, `<b>` and `<!-- -->` mid-line, angle and
email autolinks, `\<tag>` backslash tricks, a line-leading `<div>` pair whose
closer must also die, bracket links and `![image]` markdown, delimiter and
code-span combinations, entity-lookalikes, and bare URLs. Guards pin the
survivors: server canonical/event/calendar links, headings, status, event
keys, privacy, multiline paragraphs, and byte-identical plain/Unicode prose.
`test/ai-friendly-md-host-join-acceptance.test.ts` pins the 38 Host/Join
cases: `- Host:`/`- Join:` presence and labels on detail and list, blank
omission, ETag invalidation on host/join edits, envelope/TTL/robots parity,
no-cookie viewer-independent bytes, the HTML-detail visibility diff, and
hostile organizer/join text staying inert.

## Non-claim

Neutralizing markup says nothing about natural-language prompt injection. A
hostile sentence that reads as an instruction stays a sentence; escaping only
stops it becoming HTML, a link, or an image.
