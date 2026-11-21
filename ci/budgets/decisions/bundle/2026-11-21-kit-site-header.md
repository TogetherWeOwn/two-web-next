# Shared Kit header stylesheet

Manual SSR can link `/kit-site-header.css` rather than emitting a standalone
Vite CSS asset. `npm run build:assets` derives it from
`web/src/lib/site-header.css`, which still feeds the Kit root and inline leaf
CSS. Ordinary routes do not link the standalone file.

| `public/kit-site-header.css` | Raw bytes | Default-zlib gzip bytes |
| --- | ---: | ---: |
| Measured output | 2760 | 1011 |
| New ceiling | 3584 | 1280 |

Multiply the measured sizes by 1.25 and round up to 512-byte raw and 256-byte
gzip increments. This new asset has no previous ceiling. All other served and
Kit route budgets are unchanged.
