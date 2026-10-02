// A calendar date, optionally carried in a legacy YYYY-MM-DD[T ]HH:mm[:ss]
// value. Validate the time too, but never shift the date or store that time.
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

export function parseRecurrenceDate(raw: string): Date | null {
  const m = DATE_RE.exec(raw);
  if (!m) return null;
  if (
    m[4] !== undefined &&
    (Number(m[4]) > 23 || Number(m[5]) > 59 || (m[6] !== undefined && Number(m[6]) > 59))
  ) {
    return null;
  }
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null;
}
