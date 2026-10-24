# Inventory return screenshots

18 shots: 9 documents at 1280x800 and 390x844.

States: contextual list (row links carry the origin), contextual edit
("Back to these event results" under the H1), direct edit (fallback, no
Back link), post-save edit (Back retained after one save POST and its
303), and the 422 validation refusal (error summary plus Back link).
The refusal POST renders through the shared admin route, so it is
identical for both twins and is shot once.

Method: real Hono responses and Kit SSR bodies from the hermetic
acceptance harness, served with the shipped public assets plus the
built Kit stylesheet, captured with headless Chromium. Kit bodies are
wrapped in a screenshot-only shell that mirrors the stylesheets the
real page emits. No live route, database, or deployment was touched.
Every image was opened and checked.

- `Hono-list-contextual`, `Kit-list-contextual`: filtered inventory.
- `*-edit-contextual`: Back link present.
- `*-edit-direct`: fallback, no Back link.
- `*-edit-postsave`: Back link retained after save.
- `Hono-edit-refusal422`: refusal keeps the results return.
