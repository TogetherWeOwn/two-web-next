const UNAVAILABLE_TAIL =
  " conversion is unavailable. Use the host schedule above or the calendar links.";

export const DEVICE_TIMEZONE_UNAVAILABLE = `Device timezone${UNAVAILABLE_TAIL}`;

export const CHOSEN_TIMEZONE_UNAVAILABLE = `Chosen timezone${UNAVAILABLE_TAIL}`;

const OFFSET_PATTERN = /^GMT(?:[+-]\d{2}:\d{2}(?::\d{2})?)?$/;

// Called only after activation in the browser. Never infer an offset from today's date.
function readInstant(datetime: unknown): Date | null {
  if (typeof datetime !== "string" || !datetime.trim()) return null;
  const instant = new Date(datetime);
  return Number.isFinite(instant.getTime()) ? instant : null;
}

function formatInstantInZone(instant: Date, zone: string): string | null {
  try {
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
    if (!offset || !OFFSET_PATTERN.test(offset)) return null;
    const text = formatter.format(instant);
    return offset === "GMT" ? text.replace(/GMT\b/, "GMT+00:00") : text;
  } catch {
    return null;
  }
}

export function eventStartInDeviceTimezone(datetime: unknown): string {
  try {
    const instant = readInstant(datetime);
    if (!instant) return DEVICE_TIMEZONE_UNAVAILABLE;
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof zone !== "string" || !zone.trim()) return DEVICE_TIMEZONE_UNAVAILABLE;
    const text = formatInstantInZone(instant, zone);
    if (!text) return DEVICE_TIMEZONE_UNAVAILABLE;
    return `In your device timezone: ${text} (${zone}).`;
  } catch {
    return DEVICE_TIMEZONE_UNAVAILABLE;
  }
}

export function eventRangeInChosenTimezone(start: unknown, end: unknown, zone: unknown): string {
  try {
    if (typeof zone !== "string" || !zone.trim() || zone.length > 64)
      return CHOSEN_TIMEZONE_UNAVAILABLE;
    const first = readInstant(start);
    const second = readInstant(end);
    if (!first || !second) return CHOSEN_TIMEZONE_UNAVAILABLE;
    const startText = formatInstantInZone(first, zone);
    const endText = formatInstantInZone(second, zone);
    if (!startText || !endText) return CHOSEN_TIMEZONE_UNAVAILABLE;
    return `In ${zone}: starts ${startText}; ends ${endText}.`;
  } catch {
    return CHOSEN_TIMEZONE_UNAVAILABLE;
  }
}
