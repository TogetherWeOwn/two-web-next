# ADR 0003: Discord realtime protocol v1

- Status: Accepted on merge
- Date: 2026-11-21

## Decision

The bot sends signed, normalized state changes to one Cloudflare Durable Object per configured guild and environment. The hub maintains current state, not an event log. It projects state for each viewer before sending it over same-origin WebSockets using the Hibernation API. Svelte stores start from server-rendered data and update without a page reload. Target: bot forwarding within about 100 ms and Discord-to-screen p95 below one second for eligible changes. Ship default-off, qualify on staging first, and do not add another source of authentication or mutation authority.

## Public voice count compatibility

Use `/api/discord-live/v1` for the default-off Kit public voice count slice.
The path selects this contract. The separate `/api/realtime/v1/ws` design below
defines the broader topic and stream protocol, including member detail. A client
binds to one path and its wire format. Moving this slice to the broader endpoint
requires a separately qualified migration. The signing and private projection
requirements below continue to govern the broader design.

- Connect with a same-origin WebSocket upgrade and no query or subprotocol. The
  server checks `Origin` and selects the configured guild and session. A
  presented invalid session fails admission. Use the same public count for
  guests and session-bearing viewers. The public slice exposes only `voice`.
  The installed hub recognizes `channels`, `members` and `events` commands and
  returns unavailable controls for them. Keep them out of the public adapter.
- Subscribe once with `{v:1,type:"subscribe",topics:["voice"]}`. Resync that
  subscription with `{v:1,type:"resync",topics:["voice"]}`. Commands are closed
  JSON text objects capped at 512 UTF-8 bytes. Serialize commands and respect the
  server's two-second per-socket cooldown, armed when it accepts subscribe or
  resync. A second subscribe, an overlapping command, an early resync or a
  resync outside the original subscription can close the socket with `1008`.
- After a withdrawal or gap with no command pending, the browser requests a
  covering snapshot on the current socket. Wait at least two seconds after the
  last command's baseline was received and pace recovery with backoff and
  jitter. The qualified hub requires a browser command to restore a withdrawn
  lease and can defer a pull under its separate five-second per-guild budget.
  Routine recovery sends resync only while the live value is unusable.
- A usable snapshot ends the browser's command wait. An unavailable control
  can precede that snapshot, or it can be the only response. Keep the socket
  and accept a covering snapshot during the wait. If no usable snapshot arrives
  within 15 seconds of sending the command, retire the socket before closing it
  and retry with a fresh subscription and reconnect backoff. This avoids sending
  a second command on a socket whose prior command may still be running. A
  close or failed upgrade also starts fallback and a fresh connection attempt.
  Reset reconnect backoff after a usable baseline.
- A baseline or full replacement is exactly
  `{v:1,type:"snapshot"|"patch",topic:"voice",seq,value:{count}}`. `count` is
  a safe integer of at least five for eligible humans in explicitly allowlisted
  public rooms, or `null` for suppression below five. `seq` is a positive
  socket-local voice revision (currently capped at 1,024). The first snapshot on
  a new socket starts at one. Apply only the next patch to a known baseline.
  Ignore ordinary duplicates and older revisions. On a forward gap, stop using
  the live value and require a snapshot with `seq` at least as high as the
  highest revision observed in that gap and higher than the last accepted
  revision. Discard revision state when retiring the socket.
- `{v:1,type:"unavailable",topic:"voice"}` withdraws the live value and has
  no cursor or value. Keep the subscription, retaining its revision watermark
  and any observed gap, and accept a covering higher-revision snapshot on that
  socket, including one arriving immediately after withdrawal. Start fallback
  while the value is unavailable. A close ends the subscription. Reconnect with
  backoff and jitter, and establish a new baseline after fresh admission. The
  broader protocol's `reset` and fresh stream at sequence zero apply on its own
  endpoint.
- The installed hub can return a same-revision snapshot on explicit resync of
  an unchanged live count using its current source. The adapter may rely on
  this response only after the fresh covering pull and send-boundary
  reauthorization are qualified. Accept it only for an outstanding explicit
  resync on the current socket, with the last accepted value, an unwithdrawn
  baseline and no higher revision to cover. An unsolicited equal revision, or
  any equal revision after withdrawal, cannot establish a baseline.
- Source freshness and socket expiry are server-authoritative. This wire sends
  neither heartbeats nor deadlines to the browser. An open socket can be quiet
  through a source lease withdrawal and subsequent recovery. Act on controls and
  close events, and allow bounded waits for connection or recovery attempts.
  Do not expire an established baseline just because it has been quiet for 30
  seconds. The hub enforces source expiry separately from the five-minute socket
  cap and the earlier, shorten-only session deadline. Handle `1008` (policy,
  expiry or revocation), `1011` (server error) and `1012` (session-bearing
  source loss or revision cap) as closed subscriptions. Reconnect with fresh
  admission and backoff. Admission failure, including capacity exhaustion,
  leaves the view on fallback.
- An independently authorized and projected same-origin read, where available,
  is the 10-second fallback. Validate its origin, audience and closed public
  count before publishing. Label fallback data as potentially old and retain the
  distinction between suppression and unavailable. Never use a raw bot
  snapshot, widget presence or a member-detail response for this count. A
  baseline stops polling. Withdrawal, baseline installation, socket retirement,
  view or session replacement, and teardown invalidate pending poll results.
  This decision adds no polling URL or route wiring.

### Public count conformance

Share the synthetic wire cases between the installed Worker fixture, the browser
adapter tests and the Chromium fixture. Exercise closed frame and count shapes
(including four/five/four and restricted-room silence), initial snapshot and
duplicates, gap and cooldown with behind and covering baselines, and equal
revisions only in the resync case above. Check browser-initiated resync after
withdrawal and same-socket recovery immediately after a control and after
hibernation. Exercise competing sockets, a deferred pull that yields only
`unavailable`, and a delayed pull while the browser holds its command slot.
On an exhausted command wait, prove fallback and fresh admission without a
second command on the old socket. Separately check quiet socket behavior past
30 seconds and reconnect after an actual policy Close. Deliver late frame,
close, retry and poll callbacks after replacement.
Exercise the 10-second fallback, origin and projection rejection, and teardown.

The [installed #2617 job](https://github.com/TogetherWeOwn/two-web-next/actions/runs/45143824702/job/137588087672)
at `f0c2fc4c6be4a26dfe36afc367820c3dd51a64f1` demonstrates the landed
[#2616](https://github.com/TogetherWeOwn/two-web-next/pull/2616) and
[#2617](https://github.com/TogetherWeOwn/two-web-next/pull/2617) slice, including
warm same-socket recovery, public scope and default-off parity. It predates the
compatibility qualification below. Historical draft runs are diagnostic evidence.

Before implementing the adapter or integrating it into a route, land the
fixture qualification in #2618 and the behavior in #2628–#2631, or reviewed
equivalents. Pin the accepted hub SHA and its passing ready-head installed
Worker job. That job must prove restored room access, cold same-socket wake and
staggered idle `1008` closes, rejection of stale covering observations without
lease extension from deltas (#2628), and no withdrawal or lease activation on a
producer-only cold wake before the original deadline (#2629). Also require a
fresh covering pull for resync, same-revision proof for an unchanged live value,
and no extension of another socket's lease (#2630), plus a fresh session and
attachment check at the send boundary and voice delivery during unrelated-topic
resync (#2631). Record the hub SHA and job with the unwired adapter evidence,
including the Workers typecheck. Route integration also requires the Chromium
cases against that same contract. Keep activation under the separate release gate.

## Bot → hub: allowlist and wire shapes

All messages are UTF-8 JSON. `Id` means a nonzero Discord snowflake encoded as a decimal string, never a JSON number. Times are UTC RFC 3339 strings. Each entry is `{op, data}`, with the exact `op` and `data` fields named below. A `put` replaces the entire keyed record, including explicit `null`s and empty lists; a `remove` contains only its key. The bot hydrates partial gateway dispatches from its coherent cache. Exclude bot and AFK sessions from browser output, but preserve internal dependency updates so a membership, role or AFK-channel change can recompute the projection without a fresh voice dispatch. If it cannot prove the complete record, it stops that guild's live feed and rebuilds; it does not substitute empty data. Envelopes and records are closed schemas. Unsupported dispatches never consume a sequence number.

| Gateway dispatch | Normalized `ops` entry | Record or key |
| --- | --- | --- |
| `VOICE_STATE_UPDATE` | `voice.put`, `voice.remove` | `{userId, channelId}` keyed by `userId`; disconnect removes `{userId}`. A move is one replacement, not two deltas. |
| `CHANNEL_CREATE`, `CHANNEL_UPDATE`, `CHANNEL_DELETE` | `channel.put`, `channel.remove` | `{id, name, kind, parentId, position, overwrites}` or `{id}`. `kind`: `voice`, `stage`, `category`, `other`. Each overwrite is `{kind: "role"\|"member", id, allow, deny}`. Keep permission-bearing channels and categories even if they will never be projected. |
| `GUILD_MEMBER_ADD`, `GUILD_MEMBER_UPDATE`, `GUILD_MEMBER_REMOVE` | `member.put`, `member.remove` | `{userId, roleIds, nick, bot, pending}` or `{userId}`. `nick` is nullable; `bot` and `pending` are booleans. Membership removal also clears the user's voice state. |
| `GUILD_ROLE_CREATE`, `GUILD_ROLE_UPDATE`, `GUILD_ROLE_DELETE` | `role.put`, `role.remove` | `{id, permissions}` or `{id}`. Includes `@everyone` (guild ID). Deletion removes that role from effective permissions immediately; dangling references grant nothing. Role names and colors are not used. |
| `GUILD_UPDATE` | `guild.put` | `{ownerId, afkChannelId}`; `afkChannelId` is nullable. Other fields are ignored. |
| `GUILD_SCHEDULED_EVENT_CREATE`, `GUILD_SCHEDULED_EVENT_UPDATE`, `GUILD_SCHEDULED_EVENT_DELETE` | `event.put`, `event.remove` | `{id, channelId, status, title, description, location, startsAt, endsAt}` or `{id}`. Status is `scheduled` or `active`; completion, cancellation, deletion or loss of structural admission removes the item. Channel, description, location and end can be null. |

Permission bitsets (`allow`, `deny`, `permissions`) are unsigned decimal strings; evaluate with integer bit operations that preserve all bits. Nullable parent and channel references are not permission proof. Channel removal also clears its voice rows and withdraws linked event detail. Apply all operations in one delta atomically before evaluating visibility. Retain structurally valid scheduled/active events in the bounded producer and hub state, even beyond the [calendar's 90-day display horizon](../../src/events/discord-transients-live.ts). Apply the horizon in projection only. Do not fabricate an end time for active voice/stage events. If complete state cannot fit the declared bounds, use the existing fallback instead of dropping rows silently.

`READY`, `RESUMED`, guild availability and member chunking are lifecycle/bootstrap signals, not browser data. An unavailable guild, an incomplete roster or permission cache, or a gateway reconnect without continuity makes the producer unready. Bootstrap from a complete current gateway cache or bounded authenticated reads, not partial member chunks. Do not forward presence dispatches, message or thread content, activities, attendee identities, raw users, avatars, invites, or audit data. OAuth account identity and site profile display/consent remain site-owned.

## Signing, sequencing and recovery

- `POST /internal/realtime/v1/ingest` (bot → site) takes a delta, snapshot, or heartbeat. `POST /internal/realtime/v1/resync` (site → bot) takes `{v:1, guildId, resyncId, generation}`. The bot returns `202` for a queued challenge and delivers the signed snapshot to ingest; the resync response never contains state. Both routes are exact paths with no query or redirects.
- Reuse the [bot signing format](../../src/bot/signer.ts): `X-TWO-Key-Id`, `X-TWO-Timestamp` (Unix seconds), `X-TWO-Nonce` (32 lowercase hex characters), `X-TWO-Signature` (`sha256=` plus lowercase HMAC-SHA256 hex). Sign `POST\n<path>\n<timestamp>\n<nonce>\n<lowercase SHA-256 hex of raw body>` with no final newline. Hash and verify the received bytes, not reserialized JSON. Use scoped keys per direction and environment, verified with constant-time comparison. Key policy binds the allowed guild and verb; a browser cookie or an action signer is not a realtime credential.
- Reject missing, duplicate or malformed signing headers, clock skew beyond ±60 s, and reused nonces within their acceptance window. Claim nonces atomically after verification and guild binding, before side effects; retain each accepted nonce until its signed timestamp plus 60 s has passed, including across eviction. Bound the replay cache, rate-limit requests and fail closed on capacity. Retry the same body with a fresh timestamp/nonce. Never log bodies, signing material, raw IDs or rendered identities.
- Delta: `{v:1, kind:"delta", guildId, epoch, seq, ops:[...]}`. Snapshot: `{v:1, kind:"snapshot", guildId, epoch, seq, resyncId, generation, state:{guild,channels,roles,members,voice,events}}`. Heartbeat: `{v:1, kind:"heartbeat", guildId, epoch, seq, ready}`. Snapshot collections are arrays of complete `put` records, with unique keys and no dangling permission dependencies; `guild` is the single guild record. `epoch` and `resyncId` are independent random 128-bit values encoded as lowercase hex; `seq` is a nonnegative JSON safe integer and `generation` is a positive JSON safe integer.
- One active producer per guild. Sequence deltas contiguously starting at 1 in a producer epoch; `seq:0` is the initial snapshot watermark, not a delta. Preserve the epoch and counter only across a proven Discord resume; on loss of continuity, restart or counter exhaustion, rebuild and start a new epoch. Changes captured during snapshot creation queue behind a fence: its state is exactly after `seq`, and the next delta after it is `seq + 1`. The producer holds those deltas until snapshot acknowledgement. Bound the queue; on overflow drop it, declare unready and resnapshot rather than creating a hole.
- The hub applies a valid delta only when synchronized at that epoch and `seq` is exactly next. `204` means committed or an exact retry of the last accepted envelope (compare digest); same sequence with different bytes is a conflict. Older deltas in the same epoch are ignored (`204`). A gap, unknown epoch, conflict, incomplete state, or hub restart without current state marks the feed unready and returns `409`. A rejected message cannot partially change state or move the watermark.
- On startup or loss of sync, the hub requests a snapshot with one outstanding challenge per guild and environment: a fresh single-use `resyncId` and a strictly increasing `generation`. Persist the generation before sending and never reset it on eviction or restart. Retry the same pair with backoff; challenges expire after 60 s. Admit only a complete snapshot bound to both fields of the outstanding challenge, without rolling back a same-epoch watermark; consume the challenge and swap state/cursor atomically before `204`.
- A retry of the exact accepted snapshot gets `204` without reapply only if the hub still has usable current state built on that snapshot in the same epoch. If that baseline was lost, return `409` and deliver the outstanding or fresh challenge through the signed resync route. Reject delayed, unsolicited or superseded snapshots with `409` without disturbing usable state. Until repaired, do not apply or fan out raw deltas.
- The producer serializes challenge handling per guild and environment and durably records the highest accepted `(generation, resyncId)` before changing the fence or acknowledging the request. A lower generation (even if never seen), a conflicting ID at the same generation, or a retry of a known pair whose producer state was lost gets `409` without changing the fence. If that response is for the hub's still-outstanding challenge, it requests a fresh higher generation; ignore responses to superseded challenges. An exact retry with intact producer state gets `202` without creating a new cut. Neither side resets ordering on restart; if durable ordering is unavailable or exhausted, stay unready and fall back rather than resetting it.
- Only a higher generation supersedes a producer fence. Ignore later ACKs for the previous fence. While continuously tracking changes, serialize a new snapshot cut from the current cache, including all held changes through the new watermark. Retire queued deltas through that watermark, keep later deltas behind the new fence, and release from `seq + 1` only on the current snapshot's `204`. If continuity is lost, rebuild under a new epoch instead.
- Heartbeats every 10 s report readiness and last acknowledged producer watermark; they do not advance it. Unready, a heartbeat ahead of the hub, an epoch mismatch, or 30 s without a valid ready heartbeat ends live status and initiates recovery. Serialize heartbeats with ingest so a heartbeat cannot overtake a delta. Prefer fresh baselines over persisted state after eviction. Keep no history; retain only bounded current state and protocol metadata.
- Stop reading at 1 MiB on ingest and 1 KiB on resync, regardless of `Content-Length`. After verification enforce the narrower ingress limits: 64 KiB and at most 128 operations for deltas, 1 KiB for heartbeats. Reject malformed bodies (`400`), unauthorized requests (`401`), oversized bodies (`413`) and rate limits (`429`) before mutation. Do not truncate snapshots to fit; oversized guilds stay on the safe fallback until they can be supported within explicit limits.

## Browser topics and cursor for `/api/realtime/v1/ws`

Clients connect to `/api/realtime/v1/ws`. Require exact same-origin `Origin`; reject missing or foreign origins. Resolve the existing site session server-side. Requests without a session cookie may subscribe only as guests; reject a presented session that cannot be verified. The server chooses the configured guild and principal, never query/body inputs. Client messages are `{v:1, type:"subscribe", topics:[...]}` (a nonempty set of unique names from the table) and `{v:1, type:"resync", topic}`. Reject unknown inputs and bound socket counts, frame size, rates and pending sends. A slow client reconnects with backoff and jitter; it does not grow a replay queue.

The first `subscribe` fixes the topic set for that socket's lifetime. A second `subscribe` or a `resync` outside that set closes the socket with `1008` without registering new topics or sending topic data. When the page no longer needs the same set or the session changes, the client retires the old socket before closing it, clears the dropped topics (all old-session topics on session change), and invalidates their pending polls. Only callbacks from the current socket may change client state: ignore frames, disconnects and retry callbacks from retired sockets. Open a new socket and subscribe to the new set only if it is nonempty; the hub drops all subscriptions and pending sends for the closed socket. A view-filter change that preserves the set can reuse the socket.

| Topic | Guest and signed-in non-member | Site member |
| --- | --- | --- |
| `voice` | `{count}` where `count` is the eligible guild-wide human count at five or more, or `null` below five. | `{rooms:VoiceRoom[]}` for page-approved rooms only. |
| `channels` | Unavailable; public metadata stays on the widget path. | `{rooms:ChannelRoom[]}` for the same page-approved voice/stage rooms; no arbitrary text channels, parent IDs or overwrites. |
| `members` | Unavailable. | `{member:true,nick:string|null}` for the authenticated viewer only, and only if the page already exposes those Discord-derived facts. `member:true` means current site membership and current Discord membership are both proven; `nick:null` means no Discord nickname is set, not loss of proof. Otherwise unavailable. No roster, Discord ID, role IDs or moderator claims. |
| `events` | Unavailable; keep the existing public calendar read. | `{events:CalendarEvent[]}` with only page-eligible Discord transients, before presentation filters. Room-linked rows also require room access unless the page independently publishes that event to guests. |

Topic values and nested records are closed; every listed field is required, including nullable fields. Arrays are `[]` when authorized and empty. `N` is a nonnegative safe integer and `Time` is a UTC RFC 3339 string. `Id` is as above. The exact nested records are:

- `VoiceRoom = {channelId:Id,name:string,count:N,occupants:Occupant[],occupiedSince:Time|null,eventKey:string|null,canMove:boolean}`. Count includes page-eligible occupants who cannot be named; `canMove` is false without permission.
- `Occupant = {name:string,avatarUrl:string|null}`. Use `null` for initials when no page-approved ID-free avatar is available.
- `ChannelRoom = {channelId:Id,name:string,kind:"voice"|"stage",position:integer|null}`. `position` is a safe integer when known, otherwise `null`.
- `CalendarEvent = {discordId:Id,status:"scheduled"|"active",title:string,description:string|null,location:string|null,startsAt:Time,endsAt:Time|null}`. No channel IDs or permission metadata.

For `events`, the hub requires current site membership before projecting any value; public calendar visibility does not grant a socket subscription. The hub also enforces [page eligibility and canonical suppression](../../src/events/page-models.server.ts) before serializing snapshots and patches: omit any Discord ID [mapped to a local event](../../src/events/reads.ts), even if the local event is hidden, draft or otherwise absent from this viewer's calendar. This also applies to external events. Require current mapping proof; if unavailable, withhold the affected data. Invalidate on local mapping changes before the next event send and recompute without waiting for Discord. Withhold linked rows with unknown exposure rather than redacting a room ID to make them public. Recompute eligibility at time boundaries, including when a retained row enters the 90-day window or passes its end without a dispatch.

The `events` subscription carries no view parameters. The browser narrows the eligible feed before rendering each replacement and whenever the committed page view changes. Use the normalized view state from the page model: a recognized game facet excludes all transients; search matches title or description case-insensitively; show transients only on list page 1 unless there are no matching canonical upcoming rows; and in the month grid admit starts on the visible grid days in the resolved page time zone. If that state is unavailable, do not overlay the feed. Replace only the transient portion, then use the page's merge and ordering rules. Site-native events, RSVPs and registrations remain on their existing paths. Client filtering never substitutes for server eligibility or authorization.

For each requested topic, subscribe and resync complete with `{v:1,type:"snapshot",topic,stream,seq:0,value}` if available, or `{v:1,type:"reset",topic}` if unavailable. Reset has no value or cursor; it clears any baseline and ends the outstanding request without exposing why the topic is unavailable. Keep the subscription registered; a later authorized, available baseline uses a new stream. An empty value or a suppressed count is a valid snapshot, not a reset. `stream` is an opaque fresh ID per topic and baseline. A patch is `{v:1,type:"patch",topic,stream,seq,value}` with `seq` one greater than the last sent for that stream. A patch replaces the full topic value. Send only on projected changes; do not send further resets on hidden changes while already unavailable. No bot cursor, no gaps caused by other viewers' changes, and no replay on reconnect. The client ignores duplicates and requests a new baseline on a forward gap or unknown stream; it never merges a patch without a matching baseline. SSR can seed an authorized topic using the same projector but does not imply a stream cursor. The existing public calendar read is independent of the socket.

On a gap, revocation or unavailable source, the hub sends `{v:1,type:"reset",topic}` or closes the socket. Clients discard live values on reset or disconnect, clear private detail, and use the existing 10-second projected snapshot poll where available with a “may be a few seconds old” label. Without a current authorization proof, even polling/SSR fallback cannot retain private rows. Unavailable is not empty; a suppressed guest count is not zero. A fresh WebSocket baseline replaces fallback and ends polling.

Each topic has a local fallback generation. Advance it on reset, disconnect, baseline installation and session or view replacement; clear any private detail invalidated by the change. A poll captures its generation when it starts. Apply its result only while that topic is still in fallback, with the same generation and context, and only if no newer poll result has been applied. Abort old polls where possible, but check the generation before writing to the store regardless of cancellation. Fallback requests must still project under current authorization; generation checks are not authorization.

## Projection is the privacy boundary

Project every snapshot and patch using the same policy as the page. For room detail, require a current site member and trusted per-viewer Discord access for that page and room. Evaluate the current guild and member roles, `@everyone`, role and member overwrites, and the applicable Discord owner/administrator semantics for `VIEW_CHANNEL`; do not treat a moderator bit, a room ID, or presence in the room as proof. Require `CONNECT` and the separate page rule for any join/move affordance; push is not authorization for the action. Never treat projected bot roles as an input to granting site privileges. Existing [site role recheck](../../src/session-role-refresh.ts) remains authoritative for site authorization.

Exclude bots and AFK occupants before counting. For visible rooms, use only current site-profile names when the existing live-room preference permits it; absent or stale profile proof emits no identity. Never fall back to a Discord nickname or username for another occupant. Only use an ID-free avatar already allowed by the page or render initials. No occupant Discord IDs, CDN URLs embedding IDs, or raw site/profile/session identifiers reach the browser. Derive voice timing and site event keys only from proven current state; otherwise `null`. A departed or opted-out viewer/occupant, session expiry/logout, overwrite/role change, guild disconnect, or failed authorization must invalidate affected projections even without a visible voice patch. Wire session and profile changes into hub invalidation before enabling private topics, alongside the Discord access updates above. Recheck after hibernation and before sends; never carry stale permission or consent forwards in socket attachments. Invalidation of a private subscription clears it immediately; do not emit hidden-change ticks to guests.

## Page coverage and retained reads

V1 pushes eligible voice counts, and for members it pushes page-approved room details, the eligible viewer's own membership/nickname, and page-eligible Discord calendar transients. Guest and signed-in non-member sockets are counts-only. The following Discord-backed values stay off-stream:

- Guests and signed-in non-members keep the [existing public calendar read](../../src/events/page-models.server.ts), with its current visibility and filters. Live public non-count fields, including calendar transients, are a v1 coverage gap; do not widen the socket contract to fill it.
- `/join` keeps the [public widget preview and online count](../../src/discord-widget.ts) on the existing cached widget path and fallback. Widget presence is not in-voice presence; do not label widget reads as gateway-live or enable privileged presence to replace them.
- The homepage keeps [human-member and online counts from `web_v1.live_counts`, and rank totals from `web_v1.rank_counts`](../../src/counts.ts). Preserve the existing 60-second read cache, count timestamp/freshness rules (ten minutes), and unavailable behavior. Do not derive either count or ranks from voice or nickname deltas.
- Member profiles keep [join date, tenure, rank, and membership facts from `web_v1.members`, and milestones from `web_v1.member_milestones`](../../src/profiles/stats.ts) on the existing request-time read path and its unavailable/partial fallback. The narrow `members` topic does not refresh these views or grant privileges.

## Implementation verification

Share synthetic signing and wire fixtures across bot and site. Cover real join/leave/move and channel, role, nickname and event updates; replay, malformed payload, wrong guild, gap, duplicate, racing/stale snapshot and restart; and convergence after hibernation/reconnect. Include these shared cases:

- Commit snapshot A at `seq:10`, lose its ACK, then restart the hub without state. The retry gets `409`; a fresh challenge B supersedes A. B's cut at `seq:11` includes the held change at 11. A's delayed ACK releases nothing; B's `204` releases delta 12, which the hub applies next.
- Issue A at generation 7 and B at 8, with a hub restart between them. Deliver B before the bot ever sees A. A's delayed request gets `409`, leaving B's fence intact; B's snapshot ACK releases the next delta. In a second run, restart the bot after accepting B but before ingesting its snapshot. The stale A still gets `409`; a retry of B with its cut lost makes the hub issue generation 9.
- With a frozen clock, a structurally valid event just beyond 90 days stays in state but out of the projection, then enters exactly at the boundary without a Discord dispatch. Creating a local mapping to a hidden canonical event suppresses even a roomless transient in both later baselines and replacement patches.
- With an effective game facet, a replacement containing otherwise eligible Discord transients leaves the rendered schedule unchanged; removing the facet reapplies the latest eligible feed. Also check search, a later list page with canonical rows, and starts outside the visible grid in the page time zone.
- Start a private fallback poll, install a fresh socket baseline, then reset after revocation. Deliver the old poll response after the reset; it must not restore private detail even though the topic is back in fallback.
- Navigate from `voice` + `events` to `voice` only while an event frame and fallback poll are pending. Neither can refill the discarded store, and later event changes send no frames. Install a fresh `voice` baseline on the replacement, then deliver the retired socket's close callback. The new value and cursor stay intact, fallback and retry do not start, and the next in-order `voice` patch applies. Check that sending a second `subscribe` or resyncing an unregistered topic closes the current socket without topic data.
- Share one synthetic baseline/reset pair per topic: guest voice `{count:null}`; authorized channels `{rooms:[]}`; members `{member:true,nick:null}`; authorized member calendar `{events:[]}`. Verify each reset has no value or cursor and a later baseline starts a fresh stream. Exercise a full member voice room with nullable timing, event key and avatar, and a calendar row with nullable text and end.
- For both a guest and a signed-in non-member, subscribe and resync `events` when a Discord transient is visible on the public calendar. Expect only `{v:1,type:"reset",topic:"events"}` in response to each request, no event-driven frames afterward, and unchanged public calendar output. Losing membership clears the member calendar stream before any further event value can be sent.

Verify serialized SSR, polling and live frames for guest (four/five/four humans), member with/without access, moderator without proof, revoked session, AFK/bot, opted-out occupant and restricted calendar rows. Verify authorization loss before any next private send, no hidden update ticks, and honest fallback under source failure. Measure Discord-to-render latency on staging for allowed gateway changes; keep disabled by default until the implemented slices pass their review and release gates.
