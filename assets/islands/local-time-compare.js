// Both twins compare only the already-rendered saved zone. An accepted owner
// save advances that zone and discards an obsolete result, without recomputing
// or announcing another comparison until explicit activation. No live draft,
// fetch, storage, geolocation, timer, focus move, or profile write.
(() => {
  const mount = document.querySelector("[data-local-time-compare]");
  if (!mount) return;
  const button = mount.querySelector("button");
  if (!button) return;
  const dateFor = (zone) =>
    new Intl.DateTimeFormat("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone: zone,
    });
  const timeFor = (zone) =>
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: zone,
    });
  function formats() {
    try {
      const memberZone = mount.getAttribute("data-local-time-compare") || "";
      const deviceZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      if (!memberZone || !deviceZone) return;
      return [
        memberZone,
        deviceZone,
        dateFor(memberZone),
        timeFor(memberZone),
        dateFor(deviceZone),
        timeFor(deviceZone),
        dateFor("UTC"),
        timeFor("UTC"),
      ];
    } catch {
      return;
    }
  }
  const status = () => mount.querySelector("[role='status']");
  function refresh() {
    button.hidden = !formats();
  }
  document
    .querySelector('[data-testid="profile-timezone"]')
    ?.addEventListener("two:timezone", (event) => {
      if (mount.getAttribute("data-local-time-compare") === event.detail) return;
      mount.setAttribute("data-local-time-compare", event.detail);
      status()?.remove();
      refresh();
    });
  function line(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }
  refresh();
  button.addEventListener("click", () => {
    // Re-read the saved zone at activation, and use one instant for all rows.
    const parts = formats();
    if (!parts) {
      status()?.remove();
      refresh();
      return;
    }
    const [
      memberZone,
      deviceZone,
      memberDate,
      memberTime,
      deviceDate,
      deviceTime,
      checkedDate,
      checkedTime,
    ] = parts;
    const now = new Date();
    if (!Number.isFinite(now.getTime())) return;
    const children = [
      line(`Member (${memberZone}): ${memberDate.format(now)}, ${memberTime.format(now)}`),
      document.createElement("br"),
      line(`Device (${deviceZone}): ${deviceDate.format(now)}, ${deviceTime.format(now)}`),
      document.createElement("br"),
      line(`Checked at ${checkedDate.format(now)}, ${checkedTime.format(now)} UTC`),
    ];
    const existing = status();
    if (existing) {
      existing.replaceChildren(...children);
      return;
    }
    // Fill before inserting so the first announcement carries the full result.
    const created = document.createElement("p");
    created.setAttribute("role", "status");
    created.replaceChildren(...children);
    mount.appendChild(created);
  });
})();
