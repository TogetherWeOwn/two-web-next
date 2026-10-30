/** Read-only admin chronology: explicit UTC labels and lossless machine instants. */
export function formatAdminTime(value: unknown): { iso: string | null; label: string } {
  const unavailable = { iso: null, label: "Time unavailable" };
  if (
    !(value instanceof Date) &&
    typeof value !== "number" &&
    !(typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value))
  ) {
    return unavailable;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return unavailable;
  const iso = date.toISOString();
  return { iso, label: `${iso.slice(0, -5).replace("T", " ")} UTC` };
}
