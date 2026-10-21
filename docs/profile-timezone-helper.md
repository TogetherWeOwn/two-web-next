# Profile timezone helper

## Design contract

- Audience: signed-in members editing their own profile, with or without JavaScript.
- Screen job: explain the optional timezone identifier and offer a deliberate shortcut to fill it. Save remains the primary action.
- Content: “Use an IANA timezone, such as Europe/London. Leave blank if you prefer.” The secondary control reads “Use this device's timezone”; its hint explains that Save applies the change.
- References: the existing profile editor in `src/profiles/pages.tsx`, its Kit twin in `web/src/lib/ProfileView.svelte`, and the shared draft lifecycle in `assets/islands/member-profile.js`. Assumption: retain the existing visual direction rather than introduce new tokens or a new form layout.
- Layout and type: keep the ordinary labeled input, existing profile hint typography and secondary button treatment. Place guidance and the helper immediately after the input, outside its label. Reflow naturally at 1280×800 and 390×844; no fixed widths.
- States: blank and prefilled profiles; detected-but-inert; explicitly changed draft; unavailable detection; no JavaScript; saved, reset/Cancel, rejected 422 and a newer draft during an older save. Keep guidance visible and retain the existing error description association.
- Non-goals: geolocation, automatic saving, telemetry, cookies/storage, event-time personalization, timezone lists, validation changes or new dependencies.

## Behavior

The browser reads its configured timezone through Intl and validates the returned identifier with an explicit-zone Intl formatter. Missing, throwing, empty, malformed or unsupported results leave the helper hidden and manual entry available. No timezone database is shipped. The returned identifier is not normalized to a different alias.

Only pressing the helper fills the timezone input and dispatches ordinary bubbling input/change events. Nothing is saved until Save. The existing shared island owns dirty/departure warnings, reset, rejected drafts and in-flight save protection for both renderers. Server validation remains authoritative; a refused alias stays an editable rejected draft.

Without JavaScript, the guidance and manual field remain available and the native form save still works. The helper stays hidden.
