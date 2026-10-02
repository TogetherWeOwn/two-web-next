// Runtime admission for Discord scheduled-event rows. The payload is remote
// JSON, so nothing is trusted until it is a plain object with string IDs/titles
// and string-or-null optional fields. Whole-payload non-arrays are the
// caller's read failure; a malformed ROW is dropped alone so it can never
// suppress a healthy sibling or reach the calendar search as a non-string.

export type AdmittedScheduledEvent = {
  id: string;
  name: string;
  description: string | null;
  scheduled_start_time: string;
  scheduled_end_time: string | null;
  status: number | undefined;
  location: string | null;
};

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const stringOrNull = (v: unknown): string | null | undefined =>
  v == null ? null : typeof v === "string" ? v : undefined;

export function admitScheduledEvent(row: unknown): AdmittedScheduledEvent | null {
  if (!isPlainObject(row)) return null;
  const { id, name, scheduled_start_time: start, status } = row;
  if (typeof id !== "string" || !id) return null;
  if (typeof name !== "string" || !name) return null;
  if (typeof start !== "string") return null;
  const description = stringOrNull(row.description);
  const end = stringOrNull(row.scheduled_end_time);
  if (description === undefined || end === undefined) return null;
  let location: string | null = null;
  const meta = row.entity_metadata;
  if (meta != null) {
    if (!isPlainObject(meta)) return null;
    const loc = stringOrNull(meta.location);
    if (loc === undefined) return null;
    location = loc;
  }
  return {
    id,
    name,
    description,
    scheduled_start_time: start,
    scheduled_end_time: end,
    status: typeof status === "number" ? status : undefined,
    location,
  };
}
