import { eventStartInDeviceTimezone } from "../event-device-timezone.ts";

for (const root of document.querySelectorAll("[data-event-device-timezone]")) {
  const button = root.querySelector("button");
  const result = root.querySelector("[role='status']");
  const time = root.parentElement?.querySelector("time[datetime]");
  if (!button || !result || !time) continue;
  button.hidden = false;
  button.addEventListener("click", () => {
    result.textContent = eventStartInDeviceTimezone(time.getAttribute("datetime"));
  });
}
