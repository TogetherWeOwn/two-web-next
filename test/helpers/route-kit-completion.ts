import { assertTargetArtifacts } from "./route-kit-artifacts";

const apiSlices = new Set(["API-3", "API-4", "API-5", "API-6", "API-7", "API-8", "API-9"]);
const sources = new Set([
  "docs/adr/0001-sveltekit-page-renderer.md#page-families-move-to-kit-before-m0",
  "src/index.tsx admin middleware chain; API-0b",
  "src/index.tsx global middleware chain; API-0b",
]);

type Row = { scope?: unknown; slice?: unknown; source?: unknown; target?: unknown };
type Context = { sha: string; run: string; attempt: string; inputs: string };
type Obligation = {
  id: string;
  claim: string;
  row: number;
  branch: string;
  state: "required" | "unresolved";
  selectors: string[];
};
type Evidence = {
  expected: Context;
  execution: Context;
  // Candidates are independently derived from reviewed inventory, not from the manifest.
  candidates: { claim: string; row: number; id: string; branch: string }[];
  obligations: Obligation[];
  cases: { selector: string; obligation: string; branch: string; status: string }[];
};

function assertCaseEvidence(claim: string, row: number, evidence?: Evidence) {
  const fail = () => {
    throw new Error("Completion requires audited case-level evidence");
  };
  if (!evidence) return fail();
  const { expected, execution, candidates, obligations, cases } = evidence;
  for (const key of ["sha", "run", "attempt", "inputs"] as const) {
    if (!expected[key] || expected[key] !== execution[key]) return fail();
  }
  const required = candidates.filter(
    (candidate) => candidate.claim === claim && candidate.row === row,
  );
  if (
    !required.length ||
    new Set(required.map((candidate) => candidate.id)).size !== required.length
  )
    return fail();
  for (const candidate of required) {
    const matches = obligations.filter((item) => item.id === candidate.id);
    if (matches.length !== 1) return fail();
    const item = matches[0];
    if (
      !item ||
      item.claim !== claim ||
      item.row !== row ||
      item.branch !== candidate.branch ||
      item.state !== "required" ||
      !item.branch ||
      !item.selectors.length ||
      new Set(item.selectors).size !== item.selectors.length
    )
      return fail();
    for (const selector of item.selectors) {
      const results = cases.filter((result) => result.selector === selector);
      if (
        !selector ||
        results.length !== 1 ||
        !results[0] ||
        results[0].status !== "passed" ||
        results[0].obligation !== item.id ||
        results[0].branch !== item.branch
      )
        return fail();
    }
  }
}

// Empty declarations mean no completion is claimed, not that any route is complete.
export function assertCompletionDeclarations(
  root: string,
  rows: Row[],
  declarations: unknown,
  evidence?: Evidence,
) {
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
      for (const row of matching) assertCaseEvidence(claim, rows.indexOf(row), evidence);
    }
  };
  select(value.apiSlices, apiSlices, "slice");
  select(value.sources, sources, "source");
  // Retirement additionally needs independent zero-registration and dependency scans.
  if (value.api10) throw new Error("Completion requires audited case-level evidence");
}
