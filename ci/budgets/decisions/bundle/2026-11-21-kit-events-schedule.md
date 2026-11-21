# Kit Events schedule stylesheet

The Ember schedule serves a separate stylesheet so Hono and unrelated pages
keep their existing assets. The authored file ships unchanged at 3011 raw
bytes and 970 default-zlib gzip bytes. Set its first enforced ceiling to
4096 raw and 1280 gzip bytes (125% rounded up to 512 and 256 bytes).
No existing ceiling changes.
