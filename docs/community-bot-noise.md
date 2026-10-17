# Community bot-noise measurement

This procedure operationalizes the existing TWO Community goal's requirement that bot noise stay **below 20% of human-space volume**. It does not authorize monetization, change the goal, or claim that historical message data is currently available.

## Measurement definition

- **Human space:** the explicit set of text channels intended for community conversation, selected before the reporting period. Record the included channel IDs and the period alongside the aggregate result. Keep the set fixed for that period; if channel coverage cannot be established, report the result as incomplete. This is a measurement boundary, not a new channel-access rule.
- **Period:** one UTC calendar week, Monday 00:00:00 inclusive through the next Monday 00:00:00 exclusive. This weekly window is a reporting convention that aligns with the goal's weekly activity measures; it does not alter the goal.
- **Identity source:** the author on each Discord message, using Discord's `message.author` user object and its `bot` field. Discord documents `bot` as an optional boolean indicating whether a user belongs to an OAuth2 application. Use the stable message timestamp, channel ID, and author identity classification from the same message record. See [Discord Message Resource](https://discord.com/developers/docs/resources/message) and [Discord User Resource](https://discord.com/developers/docs/resources/user).
- **Human denominator (H):** count of messages in the included channels and period whose author has `bot: false`.
- **Bot numerator (B):** count of messages in those same channels and period whose author has `bot: true`.
- **Unknown identity (U):** a message whose author is absent/invalid or whose `bot` value is missing or not a boolean. Unknowns are **not humans** and are not added to H or B. Track their aggregate count for completeness; do not retain or publish member-level exports for this measure.

Compute **bot noise = 100 × B / H**. The denominator is human-message volume, not the combined total of human plus bot messages. The result passes only when the period and channel coverage are complete, H is greater than zero, and the ratio is strictly **less than 20%**. Exactly 20% does not pass. If H is zero, the ratio is undefined; report it as unavailable, not zero.

A message with `bot: true` is classified as a bot even if its display name looks human. A missing `bot` field is unknown, not a human by default. Discord's `system` field is distinct from `bot`; do not silently reclassify system users as humans or bots under this procedure. If system messages are present and their handling could affect the result, mark the measurement incomplete and resolve the classification in a separately approved policy decision before reporting a pass.

## Incomplete-data response

Report **INCOMPLETE — no threshold verdict** if any included channel or portion of the week is missing, the source cannot provide a complete message set, author classification is unavailable for any in-scope messages, or H is zero. Include the measured coverage gap and aggregate U count when known. Do not impute missing messages as zero, do not treat unknowns as humans, and do not declare the threshold met from partial data. An incomplete measurement is not evidence that the community failed the goal; it is also not evidence that it passed.

## Synthetic checks

These examples validate the arithmetic only; they are not community observations.

| Human messages H | Bot messages B | Unknown U | Calculation | Outcome |
|---:|---:|---:|---|---|
| 10 | 1 | 0 | 1 ÷ 10 = 10% | Pass, if coverage is complete |
| 10 | 2 | 0 | 2 ÷ 10 = 20% | Does not pass (boundary is strict) |
| 10 | 3 | 0 | 3 ÷ 10 = 30% | Does not pass |
| 9 | 1 | 2 | 1 ÷ 9 ≈ 11.1% | Incomplete; unknowns are excluded from H and no threshold verdict is allowed |
| 0 | 0 | 0 | Undefined (zero denominator) | Incomplete; do not report 0% |

## Source limits

The TWO Community goal supplies the existing human-participation principle and `<20%` target. The Discord API documentation supplies the message timestamp/channel/author structure and the optional bot identity flag. The weekly UTC window and channel-scope procedure above are explicit reporting conventions, not claims about current data retention or an approved data-extraction path. This document does not establish that the required history is accessible, authorize production or staging database access, or permit exporting message content or member-level data.
