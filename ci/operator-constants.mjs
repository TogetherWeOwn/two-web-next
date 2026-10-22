// Operator constants: the single source of truth for the staging origin set
// and the synthetic QA Discord snowflakes shared by bin/ and ci/ operator
// tooling. Every runtime copy below aliases these exports instead of carrying
// its own literal, so a staging-host move or QA-ID rotation is a one-place
// edit; fail-closed guards (e2e/*guard, the seed validator, src/qa.ts) keep
// local literals and the parity suite fails on drift naming this file.
//
// This module is the root of the operator-constants graph and has no
// dependencies of its own. Values are byte-identical to the production
// literals they replace; no behavior change.

export const STAGING_ORIGIN = "https://next.togetherweown.com";
export const APEX_ORIGIN = "https://togetherweown.com";
export const WWW_ORIGIN = "https://www.togetherweown.com";
export const QA_MEMBER_DISCORD_ID = "900000000000001396";
export const QA_MODERATOR_DISCORD_ID = "900000000000001397";
