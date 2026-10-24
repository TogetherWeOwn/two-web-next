// Profile local-time comparison. Both twins server-render the saved member
// timezone text plus this mount: a hidden action only. The island reveals the
// action only when the saved zone validates and both formatters construct;
// each activation snapshots one instant and renders both civil times with
// explicit zone labels and checked-at wording in a lazily created status, so
// the page carries no live region until the member asks. The result never
// refreshes on its own: no fetch, storage, geolocation, timer, focus move,
// or profile write.
(() => {
  const mount = document.querySelector("[data-local-time-compare]");
  if (!mount) return;
  const memberZone = mount.getAttribute("data-local-time-compare") || "";
  const button = mount.querySelector("button");
  if (!button) return;
  if (typeof Intl === "undefined" || typeof Intl.DateTimeFormat === "undefined") return;
  let deviceZone = "";
  try {
    if (!memberZone) return;
    new Intl.DateTimeFormat("en", { timeZone: memberZone });
    deviceZone = new Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    if (!deviceZone) return;
    new Intl.DateTimeFormat("en", { timeZone: deviceZone });
  } catch {
    return;
  }
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
  const memberDate = dateFor(memberZone);
  const memberTime = timeFor(memberZone);
  const deviceDate = dateFor(deviceZone);
  const deviceTime = timeFor(deviceZone);
  const checkedDate = dateFor("UTC");
  const checkedTime = timeFor("UTC");
  function line(text) {
    const span = document.createElement("span");
    span.textContent = text;
    return span;
  }
  button.hidden = false;
  button.addEventListener("click", () => {
    // One snapshot per activation: every civil time below derives from this
    // single instant, even when consecutive clock reads would cross midnight.
    const now = new Date();
    if (!Number.isFinite(now.getTime())) return;
    const children = [
      line(`Member (${memberZone}): ${memberDate.format(now)}, ${memberTime.format(now)}`),
      document.createElement("br"),
      line(`Device (${deviceZone}): ${deviceDate.format(now)}, ${deviceTime.format(now)}`),
      document.createElement("br"),
      line(`Checked at ${checkedDate.format(now)}, ${checkedTime.format(now)} UTC`),
    ];
    const existing = mount.querySelector("[role='status']");
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
