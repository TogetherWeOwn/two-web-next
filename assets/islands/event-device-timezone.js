import {
  eventRangeInChosenTimezone,
  eventStartInDeviceTimezone,
} from "../event-device-timezone.ts";
import { suggestTimezones } from "../timezone-suggestions.ts";

for (const root of document.querySelectorAll("[data-event-device-timezone]")) {
  const button = root.querySelector("button");
  const result = root.querySelector("[role='status']");
  const time = root.parentElement?.querySelector("time[datetime]");
  if (!button || !result || !time || root.__timezoneBound) continue;
  root.__timezoneBound = true;
  button.hidden = false;
  button.addEventListener("click", () => {
    result.textContent = eventStartInDeviceTimezone(time.getAttribute("datetime"));
  });
}

for (const root of document.querySelectorAll("[data-event-chosen-timezone]")) {
  const row = root.parentElement;
  const input = root.querySelector('[data-testid="event-chosen-timezone-input"]');
  const button = root.querySelector('[data-testid="event-chosen-timezone-button"]');
  const result = root.querySelector("[role=status]");
  const times = root.closest("dl")?.querySelectorAll("time[datetime]");
  if (!row || !input || !button || !result || !times || times.length < 2 || root.__timezoneBound)
    continue;
  root.__timezoneBound = true;
  suggestTimezones(input);
  row.hidden = false;
  input.hidden = false;
  button.hidden = false;
  button.addEventListener("click", () => {
    result.textContent = eventRangeInChosenTimezone(
      times[0].getAttribute("datetime"),
      times[1].getAttribute("datetime"),
      input.value,
    );
  });
}
