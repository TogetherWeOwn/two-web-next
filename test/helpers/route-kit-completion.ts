import { assertTargetArtifacts } from "./route-kit-artifacts";

const apiSlices = new Set(["API-3", "API-4", "API-5", "API-6", "API-7", "API-8", "API-9"]);
const sources = new Set([
  "docs/adr/0001-sveltekit-page-renderer.md#page-families-move-to-kit-before-m0",
  "src/index.tsx admin middleware chain; API-0b",
  "src/index.tsx global middleware chain; API-0b",
]);

type Row = { scope?: unknown; slice?: unknown; source?: unknown; target?: unknown };

// Empty declarations mean no completion is claimed, not that any route is complete.
export function assertCompletionDeclarations(root: string, rows: Row[], declarations: unknown) {
  if (!declarations || typeof declarations !== "object" || Array.isArray(declarations)) {
    throw new Error("Invalid completion declarations");
  }
  const value = declarations as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["apiSlices", "sources", "api10"].includes(key)) ||
    !Array.isArray(value.apiSlices) ||
    !Array.isArray(value.sources) ||
    typeof value.api10 !== "boolean"
  ) {
    throw new Error("Invalid completion declarations");
  }

  const select = (claims: unknown[], allowed: Set<string>, field: "slice" | "source") => {
    const seen = new Set<string>();
    for (const claim of claims) {
      if (typeof claim !== "string" || !allowed.has(claim) || seen.has(claim)) {
        throw new Error(`Unknown, empty or duplicate ${field} claim`);
      }
      seen.add(claim);
      const matching = rows.filter((row) =>
        field === "slice"
          ? row.scope === "api" && row.slice === claim
          : (row.scope === "page-cutover" || row.scope === "cross-family") && row.source === claim,
      );
      if (matching.length === 0) throw new Error(`Empty ${field} claim: ${claim}`);
      for (const row of matching) assertTargetArtifacts(root, row.target);
    }
  };
  select(value.apiSlices, apiSlices, "slice");
  select(value.sources, sources, "source");
  if (value.apiSlices.length || value.sources.length || value.api10) {
    throw new Error("Completion requires audited case-level evidence");
  }
}
