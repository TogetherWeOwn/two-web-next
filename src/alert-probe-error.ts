// Fixed, synthetic exception: never include request data or credentials.
export class AlertProbeError extends Error {
  constructor() { super("synthetic staging alert probe"); }
}
