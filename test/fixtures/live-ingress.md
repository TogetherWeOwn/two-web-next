# Synthetic ingress pull counts

The [ingress fixture](../live-ingress.test.ts) sends signed deltas to an
in-memory guild hub with sockets disabled. An injected clock advances past the
initial observation's deadline. A synthetic producer holds its first outage
reply until both deltas reach the hub. The fixture runs offline with synthetic
payloads and signing material.

| Step | Ingress status | New producer pulls | Total |
| --- | --- | --- | --- |
| Initial snapshot, then a contiguous delta before expiry | Both 204 | 1 | 1 |
| Two overlapping deltas after expiry, producer returns 503 | Both 409 | 1 | 2 |
| First sequential delta during outage | 409 | 1 | 3 |
| Second sequential delta during outage | 409 | 1 | 4 |
| Retry with a fresh snapshot covering the latest cursor | 204 | 1 | 5 |
| Next contiguous delta | 204 | 0 | 5 |

Coalescing limits simultaneous pulls. Once an outage response settles, the
next unapplied delta can start another pull at the same clock time.
