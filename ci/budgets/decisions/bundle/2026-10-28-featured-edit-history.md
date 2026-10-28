# Featured edit history: initial asset allocation

The stale-save form needs its original precondition across network Back and reload. Native controls may restore after a fresh GET; the island binds the baseline to the history entry, pins it again on submit, and marks a restored form as a draft before the generic editor initializes. It adds no imports, dependency, polling, or storage of draft values.

Measured with the locked esbuild minifier: **989 raw / 570 gzip bytes**. Its initial ceilings are **1536 raw / 768 gzip bytes** (measured ×1.25, rounded to the existing 512/256-byte units). It loads only on featured edit documents, before the existing editor controller, in both Hono and Kit. New slot and event editors do not load it.

An initial shared-editor implementation measured 2859/1324 bytes versus its 2048/1024 ceilings. That would unnecessarily charge every event editor and exceed the allowed in-PR raise. Isolating this genuinely feature-specific behavior keeps `admin-event-editor.js` byte-identical at **2036/979** and leaves all existing asset ceilings unchanged. This is a new asset allocation in the same feature PR, not a raised existing budget or a companion budget PR.

The generated public file is built and drift-checked through the existing fragment-driven minifier. Raw-only and gzip-only breach checks remain enforced; no class-A threshold changes or exemption is introduced.
