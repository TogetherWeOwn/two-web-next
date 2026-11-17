# Calendar card fixture evidence

Full-page screenshots of a temporary local Kit route using the application shell,
schedule styles and fixture inputs. The route and local bypass were removed; this
is not a shipped page or a visual-test baseline. Viewport heights are 800 and 844
pixels respectively; the full-page images are taller.

| File | Viewport | States |
| --- | --- | --- |
| `desktop-variants.png` | 1280×800 | Visitor, member/full, past, cancelled, Discord, search highlight |
| `mobile-variants.png` | 390×844 | Visitor, member/full, past, cancelled, Discord, search highlight |
| `desktop-collapsed.png` | 1280×800 | Draft, ongoing, long description collapsed |
| `desktop-expanded.png` | 1280×800 | Draft, ongoing, long description expanded |
| `mobile-collapsed.png` | 390×844 | Draft, ongoing, long description collapsed |
| `mobile-expanded.png` | 390×844 | Draft, ongoing, long description expanded; skip link focused |

All images were captured against source commit
`3098ecf321297f24f4a87f06f9dbee07ee45f2bf`, using temporary fixtures. The past
fixture says “Ended” and the uncapped event says “No seat limit”, matching the
production availability producer. The capture route and hook bypass were local
only; no database was contacted. There is no meaningful before image for this new,
unrouted component. Hono accessibility, Lighthouse and visual gates do not
exercise this Kit component.
