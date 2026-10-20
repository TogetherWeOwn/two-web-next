// Fresh saved-content preconditions for suites that POST to the Hono featured
// update route to pin behaviors other than staleness (precision, caps,
// throttles, validation). The baseline contract itself — server-derived,
// content-hashed, compared inside the committing lock — is pinned by
// featured-stale-save-acceptance.test.ts; this helper only mints the valid
// precondition those suites now submit, the way a rendered edit form carries it.
import type { Db } from "../../src/db/index";
import { featuredSaveBaseline, getFeatured } from "../../src/admin/store";

export async function featuredBaselineFields(db: Db, id: number): Promise<Record<string, string>> {
  const row = await getFeatured(db, id);
  if (!row) throw new Error(`no featured row ${id} for a fresh save baseline`);
  return { saved_baseline: await featuredSaveBaseline(row) };
}
