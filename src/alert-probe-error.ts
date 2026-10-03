export const ALERT_PROBE_HEADER = "X-TWO-Alert-Probe";

export function validProbeId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  );
}

// Fixed exception; the UUID correlates internal receipts, never the webhook body.
export class AlertProbeError extends Error {
  readonly probeId: string | undefined;
  constructor(probeId?: string) {
    super("synthetic staging alert probe");
    this.probeId = validProbeId(probeId) ? probeId : undefined;
  }
}
