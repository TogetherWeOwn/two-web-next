// Kit's live detail uses this timezone island in place of the ordinary bundle.
import "./event-device-timezone.js";
import { watchTimeSnapshot } from "../../web/src/lib/time-freshness";

const root = document.getElementById("kit-live-snapshot");
if (root) {
  const responseStart = performance.getEntriesByType?.("navigation")[0]?.responseStart;
  watchTimeSnapshot(
    {
      asOf: Date.parse(root.dataset.asOf),
      staleAt: Date.parse(root.dataset.staleAt),
      responseStart,
      // Private no-store: the snapshot was computed after navigation started.
      // Bound its age by the entire time to first byte, not by the client date.
      snapshotAgeAtResponseStart: responseStart > 0 ? responseStart : null,
    },
    () => {
      for (const claim of root.querySelectorAll("[data-live-fresh], [data-live-stale]")) {
        claim.hidden = claim.hasAttribute("data-live-fresh");
      }
      const link = document.createElement("a");
      link.href = location.href.split("#", 1)[0];
      link.textContent = "Refresh";
      link.setAttribute("aria-label", "Refresh the event time");
      document.getElementById("kit-live-refresh").append(" · ", link);
    },
  );
}
