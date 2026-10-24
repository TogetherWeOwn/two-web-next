// Explicit, informational "time from now" for an event detail page. The answer
// is computed once per activation from the device clock; there is no timer,
// request, storage or notification, and the host schedule stays the authority.
// A future boundary rounds up (never "in 0"), an elapsed one rounds down, and
// the exact start is underway / the exact end is ended. Plain instant
// arithmetic, so a DST shift cannot skew it.
const UNAVAILABLE =
  "Time from now is unavailable. Use the host schedule above or the calendar links.";
const span = (minutes) => {
  if (minutes < 1) return "less than a minute";
  // Past a century a day count adds nothing; keep the sentence finite.
  if (minutes > 36500 * 1440) return "more than 100 years";
  const parts = [
    [Math.floor(minutes / 1440), "day"],
    [Math.floor(minutes / 60) % 24, "hour"],
    [minutes % 60, "minute"],
  ]
    .filter(([n]) => n)
    .map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`);
  const last = parts.pop();
  return parts.length ? `${parts.join(", ")} and ${last}` : last;
};
const describe = (starts, ends, now) => {
  if (!(Number.isFinite(starts) && Number.isFinite(ends) && Number.isFinite(now)) || ends <= starts)
    return UNAVAILABLE;
  const until = (instant) => span(Math.ceil((instant - now) / 60000));
  if (now < starts) return `Starts in ${until(starts)}. Ends in ${until(ends)}.`;
  if (now < ends) return `Underway now. Ends in ${until(ends)}.`;
  return `Ended ${span(Math.floor((now - ends) / 60000))} ago.`;
};

for (const root of document.querySelectorAll("[data-event-time-from-now]")) {
  const button = root.querySelector("button");
  const result = root.querySelector("[role='status']");
  if (!button || !result || typeof Date !== "function") continue;
  root.parentElement.hidden = button.hidden = false;
  button.addEventListener("click", () => {
    const now = Date.now();
    result.textContent = describe(
      Date.parse(root.dataset.startsAt),
      Date.parse(root.dataset.endsAt),
      now,
    );
    if (!Number.isFinite(now)) return;
    const checked = document.createElement("time");
    checked.dateTime = new Date(now).toISOString();
    checked.textContent = new Date(now).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    result.append(" Checked at ", checked, ".");
  });
}
