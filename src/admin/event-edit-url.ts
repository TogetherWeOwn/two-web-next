export function eventEditUrl(key: string): string {
  return `/admin/events/${encodeURIComponent(key)}`;
}
