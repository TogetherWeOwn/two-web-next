const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLUTIONS = ["confirmed", "not_applied", "superseded"] as const;

export type ReconciliationResolution = (typeof RESOLUTIONS)[number];

/** Validate without changing the original idempotency key or accepting free text. */
export function reconciliationResolutionInput(
  key: unknown,
  resolution: unknown,
): { key: string; resolution: ReconciliationResolution } | null {
  if (
    typeof key !== "string" ||
    key.length !== 36 ||
    !KEY.test(key) ||
    typeof resolution !== "string"
  ) {
    return null;
  }
  if (!RESOLUTIONS.some((allowed) => allowed === resolution)) return null;
  return { key, resolution: resolution as ReconciliationResolution };
}

/** Refuse duplicate or unexpected form fields before resolving an intent. */
export function reconciliationResolutionForm(key: unknown, form: FormData) {
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0]?.[0] !== "resolution") return null;
  return reconciliationResolutionInput(key, entries[0][1]);
}
