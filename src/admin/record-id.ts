// Featured record IDs use PostgreSQL serial (a signed 32-bit integer).
const MAX_RECORD_ID = 2_147_483_647;

/** Admit only the canonical positive decimal spelling of a persisted ID. */
export function parseRecordId(raw: string): number | null {
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 && id <= MAX_RECORD_ID && String(id) === raw
    ? id
    : null;
}
