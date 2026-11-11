import { imageHosts } from "./image-policy";

type OperatorSetting =
  | "FEATURED_IMAGE_HOSTS"
  | "E2E_PUBLIC_READ_BUDGET"
  | "AGENT_EVENTS_ROUTE_PER_MINUTE"
  | "CSP_REPORT_SAMPLE_RATE";

// At most four successful warnings per isolate. Never retain or log values:
// even these non-secret settings can contain an accidentally pasted credential.
let warned: Set<OperatorSetting> | undefined;

export function warnInvalidConfigOnce(variable: OperatorSetting): void {
  if (warned?.has(variable)) return;
  try {
    console.warn("operator.config.invalid", {
      variable,
      action: variable === "FEATURED_IMAGE_HOSTS" ? "ignored_entries" : "using_default",
    });
    (warned ??= new Set()).add(variable);
  } catch {
    // Diagnostics must not change serving or fallback behavior. Retry next use.
  }
}

// Server CSP construction owns diagnostics; client image validation stays pure
// and does not pull warning strings or isolate state into the browser bundle.
export function operatorImageHosts(configured?: string): string[] {
  return imageHosts(configured, () => warnInvalidConfigOnce("FEATURED_IMAGE_HOSTS"));
}
