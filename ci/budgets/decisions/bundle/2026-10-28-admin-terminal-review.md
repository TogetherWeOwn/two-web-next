# Admin-only terminal review stylesheet

The native cancellation/deletion disclosures share an admin-only stylesheet.
Both admin shells link it after the base stylesheet; it must not enter the
public leaf critical-CSS bundle.

The esbuild-minified asset measures 537 raw bytes and 312 gzip bytes. Its new
fragment sets ceilings of 1024 raw bytes and 512 gzip bytes (measured size x1.25,
rounded up to the established 512/256-byte steps). These preserve the original
feature's asset ceilings under the fragmented budget format. No existing
ceiling changes.

`npm run build:assets:check` enforces source/output parity and `npm run budget`
enforces the new served-asset ceiling alongside the existing inventory.
