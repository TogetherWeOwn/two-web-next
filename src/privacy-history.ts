// Previously published privacy policy versions (U3/M257).
//
// The current policy selects content/privacy-policy-vN.md through POLICY_FILE /
// POLICY_VERSION in src/privacy.ts, and src/privacy-content.ts is its generated
// bundle copy (regen command at the top of that file). This module is the one
// metadata authority for *earlier* versions that members actually received as
// production policy. The Hono screen (src/screens/privacy.tsx), the Kit page
// (web/src/routes/privacy/+page.svelte) and the machine-readable alternate
// (mdPrivacy in src/ai-friendly/md.ts) all render from it, so the three lists
// cannot drift apart. No old policy body is bundled or imported here — entries
// link out to immutable public source snapshots, and the request path performs
// zero reads of any kind.
//
// Publication evidence for v6: production deploy and release v2026.1115.0
// (actions run 43671079084, 2026-11-15) both used
// 57f1abbc25d0b39a77d83b46eb8b803b0249bb66, whose selector picks v6. Its policy
// source blob (9b9fa33f5a25302846a69763579b20264501a230) matches the first
// v6 selector commit below, whose public source was read without authentication.
//
// Publication evidence for v5: the production
// promotion job (actions run 39189509996, 2026-10-19) binds deployment and
// release to the same preflight SHA; public release v1.0.0 targets
// 754b10b39e2b52467240c9f29d5f8c8d85eefd33, whose selector picks v5; that v5
// source blob (77d7b1c75f5b9f0df93971facaec890ab4eddd75) is identical to the
// first v5 selector commit below, whose public blob URL was read without
// authentication. v1-v4 are production-unverified (tracked file, lower number,
// staging deploy or draft announcement is not publication evidence). Version 7
// was an unpublished draft, and v8 is current.
//
// Maintainer note: add an entry only with fresh production-publication
// evidence (deploy/release/SHA linkage back to a served policy body), a full
// 40-hex sourceCommit, and a verified full-SHA public blob href that reads
// without authentication. Never list the current or a future version here,
// and never guess a URL — report an unreachable target instead of publishing
// it. Keep entries newest-first; the stable id is always `v${version}`.

export type PublishedPolicyVersion = {
  readonly id: string;
  readonly version: number;
  readonly sourcePath: string;
  readonly sourceCommit: string;
  readonly href: string;
};

export const PREVIOUS_PUBLISHED_POLICIES: readonly PublishedPolicyVersion[] = [
  {
    id: "v6",
    version: 6,
    sourcePath: "content/privacy-policy-v6.md",
    sourceCommit: "c7d10e68af4561c2878781a3655862c517a6de6f",
    href: "https://github.com/TogetherWeOwn/two-web-next/blob/c7d10e68af4561c2878781a3655862c517a6de6f/content/privacy-policy-v6.md",
  },
  {
    id: "v5",
    version: 5,
    sourcePath: "content/privacy-policy-v5.md",
    sourceCommit: "1846a6f2fbf2c956b07f72fb8c0eee76cb92c0ad",
    href: "https://github.com/TogetherWeOwn/two-web-next/blob/1846a6f2fbf2c956b07f72fb8c0eee76cb92c0ad/content/privacy-policy-v5.md",
  },
];

export type PublishedPolicyTargetCheck =
  | { readonly ok: true; readonly target: PublishedPolicyVersion }
  | {
      readonly ok: false;
      readonly code: "unknown_policy_version";
      readonly retryable: false;
      readonly next_action: string;
    };

// Fixed remediation, never the caller's input echoed back: oversized or
// hostile ids still serialize to a bounded failure without any network.
const UNKNOWN_TARGET_NEXT_ACTION =
  "Unknown previous-policy version. Open /privacy and follow one of its listed previous published versions, or stay on the current policy.";

/** Local lookup over the previous-published catalog: current, future and unverified ids are not historical targets. */
export function checkPublishedPolicyTarget(id: string): PublishedPolicyTargetCheck {
  const target = PREVIOUS_PUBLISHED_POLICIES.find((entry) => entry.id === id);
  if (target !== undefined) return { ok: true, target };
  return {
    ok: false,
    code: "unknown_policy_version",
    retryable: false,
    next_action: UNKNOWN_TARGET_NEXT_ACTION,
  };
}
