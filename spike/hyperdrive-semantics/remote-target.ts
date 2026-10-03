// Operator staging mapping: TOG-9836, comment 8f2a94fd-5663-4a0a-9087-42bfe94fae43.
// Fresh Cloudflare reads verify this exact resource/origin, not independent Neon API access.
export const REMOTE_TARGET = {
  accountId: "209cf7dd678adfb683947dd7874d05af",
  worker: "two-web-next",
  appUrl: "https://next.togetherweown.com",
  hyperdriveId: "1d48a54abd3444009b7067c03c63ff9f",
  hyperdriveName: "two-web-next-staging",
  host: "ep-raspy-math-b1m3quxu-pooler.c-5.eu-central-1.aws.neon.tech",
  database: "two",
  user: "two_app",
  project: "two-web-next",
  branch: "staging",
} as const;

export interface RemoteReceipt {
  observedAt: string;
  executorAgentId: string;
  worker: string;
  sourceVersionId: string;
  hyperdriveId: string;
  hyperdriveName: string;
  origin: { host: string; database: string; user: string; port: number };
  cachingDisabled: boolean;
  mappingSource: "operator-TOG-9836-current-cloudflare-origin-match";
}

export function requireRemoteReceipt(r: RemoteReceipt, now = Date.now()) {
  const age = now - Date.parse(r?.observedAt);
  if (
    !Number.isFinite(age) ||
    age < 0 ||
    age > 300_000 ||
    !r?.executorAgentId ||
    r.worker !== REMOTE_TARGET.worker ||
    !r.sourceVersionId ||
    r.hyperdriveId !== REMOTE_TARGET.hyperdriveId ||
    r.hyperdriveName !== REMOTE_TARGET.hyperdriveName ||
    r.origin?.host !== REMOTE_TARGET.host ||
    r.origin?.database !== REMOTE_TARGET.database ||
    r.origin?.user !== REMOTE_TARGET.user ||
    r.origin?.port !== 5432 ||
    typeof r.cachingDisabled !== "boolean" ||
    r.mappingSource !== "operator-TOG-9836-current-cloudflare-origin-match"
  ) {
    throw new Error("remote_staging_target_not_verified");
  }
}

export const REFUSAL_REASONS = [
  "receipt_unparseable",
  "receipt_not_object",
  "receipt_stale_or_unparseable_time",
  "receipt_target_mismatch",
  "binding_missing_or_not_hyperdrive",
  "binding_host_missing",
  "binding_host_direct_or_local",
  "binding_database_mismatch",
  "binding_user_mismatch",
  "binding_password_missing",
  "binding_port_invalid",
  "preflight_internal_error",
] as const;
