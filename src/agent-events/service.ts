// POST /api/agent-events: the scoped machine ingress (ports two-web AgentEventService, TOG-5510 Gate 2).
//
// One endpoint, five typed operations, one admitted caller. Checks run in an order that spends
// nothing before the request has earned it:
//   0. the outer route shield admits the hit — before auth, and before the body is even
//      canonicalized, so a spent bucket is 429 without touching the payload;
//   1. the credential identifies a grant — missing/unknown grants are refused 401
//      without digesting the payload and without an audit row (sampled warn only);
//   2. the granted payload is digested (over-deep keeps 422 plus a grant-attributed
//      audit row), then feature enabled and envelope parses;
//   3. op is one of five, grant live, grant is the admitted caller on the admitted guild;
//   4. the idempotency store answers replays for free (before rate limits);
//   5. rate limits, then the operation under a Postgres advisory lock (atomic; no KV, no cache).
// Every admitted attempt writes an audit row with a reason code and no secrets; pre-auth
// refusals (overlong credential, missing/unknown grant) write none. Postgres is the only
// coordination point, so behaviour is identical across Worker isolates.
//
// Per-concern modules live beside this barrel; this file re-exports the public
// surface so existing importers keep working. The numbered check order above is
// authoritative — ingress.ts preserves it verbatim at runtime.
export type { Answer, IngressConfig, IngressEffects } from "./types";
export { DEFAULT_CONFIG } from "./types";
export {
  digest,
  INT4_MAX,
  INT4_MIN,
  isAgentVersion,
  MAX_DIGEST_DEPTH,
  PayloadTooDeepError,
  ulid,
  validateFields,
} from "./payload";
export { throttleEnvelope } from "./rate-limit";
export { admitAgentEvent, handleAgentEvent } from "./ingress";
