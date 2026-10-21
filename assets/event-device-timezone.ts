export const DEVICE_TIMEZONE_UNAVAILABLE =
  "Device timezone conversion is unavailable. Use the host schedule above or the calendar links.";

// Called only after activation in the browser. Never infer an offset from today's date.
export function eventStartInDeviceTimezone(datetime: unknown): string {
  try {
    if (typeof datetime !== "string" || !datetime.trim()) return DEVICE_TIMEZONE_UNAVAILABLE;
    const instant = new Date(datetime);
    if (!Number.isFinite(instant.getTime())) return DEVICE_TIMEZONE_UNAVAILABLE;
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== "string" || !zone.trim()) return DEVICE_TIMEZONE_UNAVAILABLE;
    const formatter = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
      timeZoneName: "longOffset",
    });
    const offset = formatter
      .formatToParts(instant)
      .find((part) => part.type === "timeZoneName")?.value;
    // Older Intl implementations may ignore longOffset and return an ambiguous abbreviation.
    if (!offset || !/^GMT(?:[+-]\d{2}:\d{2}(?::\d{2})?)?$/.test(offset))
      return DEVICE_TIMEZONE_UNAVAILABLE;
    const text = formatter.format(instant);
    return `In your device timezone: ${offset === "GMT" ? text.replace(/GMT\b/, "GMT+00:00") : text} (${zone}).`;
  } catch {
    return DEVICE_TIMEZONE_UNAVAILABLE;
  }
}
