# Schedule recovery and month-grid cues

Allocate space for the separately developed calendar recovery cues. C3 Recovery
separates Retry and Join into a wrapping action row; C11 Month grid adds
narrow-screen scroll hints and edge cues. The styles support both Hono and Kit
calendar surfaces. This allocation does not ship the feature or change the
stylesheet itself.

| `public/schedule-theme.css` | Raw bytes | Default-zlib gzip bytes |
| --- | ---: | ---: |
| Base asset | 6136 | 1639 |
| Feature candidate | 7407 | 1952 |
| Previous ceiling | 6144 | 1792 |
| New ceiling | 9728 | 2560 |

The measured candidate's SHA-256 is
`71a79703a7c2ab18903c3cbda21a4f323774577b7aa83adc605d87eda271884a`.
It exceeds the old ceilings by 1263 raw and 160 gzip bytes. Per
[the budget policy](../../README.md), multiply the measured candidate by 1.25
and round up to 512-byte raw and 256-byte gzip steps: 9258.75 rounds to 9728,
and 2440 rounds to 2560. The resulting headroom is 2321 raw and 608 gzip
bytes over the candidate. Other asset ceilings and the frozen decision history
are unchanged. The feature remains subject to its own review and verification.
