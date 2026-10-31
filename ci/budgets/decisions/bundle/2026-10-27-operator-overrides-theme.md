# 2026-10-27 decision: retain the operator override panel's scoped stylesheet

Port the panel's existing 512B raw / 256B gzip allocation into the
fragment layout. No existing ceiling changes. The authored stylesheet
measures 277B raw / 169B gzip using the checker's default `gzipSync`
measurement (without a filename header): the original four wrapping rules
(225B / 150B) plus one `white-space: pre-wrap` rule so stored values keep
their whitespace. It loads only on the read-only panel; the five rules stay
out of shared styles and the homepage's inlined critical CSS.

The original decision from the pre-fragment branch is preserved here:

> The operator-overrides-theme stylesheet is authored in public and loaded only by the read-only panel: four rules moved out of shared styles to preserve the homepage inline-CSS ratchet. Its new 512B raw / 256B gzip ceilings follow measured size x1.25 rounded up; no existing budget changes.

Keep main's frozen history byte-identical. Remove the obsolete monolith
rather than leave two competing budget authorities.
