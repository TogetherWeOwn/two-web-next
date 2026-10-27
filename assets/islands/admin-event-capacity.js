// Explains the proposed capacity as it is typed, against the Going snapshot the
// server rendered beside the input (data-occupied / data-capacity). Advice
// only: it never rewrites the value, never disables Save and never reserves a
// seat; the locked server save re-counts and keeps the last word. Input events
// only: no polling, no requests. The sentences mirror src/admin/event-capacity.ts.
(() => {
  const input = document.getElementById("f-capacity");
  const snapshot = document.getElementById("capacity-snapshot");
  const advice = document.getElementById("capacity-advice");
  if (!input || !snapshot || !advice) return;
  const seen = snapshot.getAttribute("data-occupied") || "";
  if (!/^\d+$/.test(seen)) return;
  const occupied = Number(seen);
  const hint = "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.";
  const update = () => {
    const raw = input.value.trim();
    const n = Number(raw);
    let text;
    if (!raw) text = "Unlimited: no cap applies. " + hint;
    else if (!/^\d+$/.test(raw) || n < 1 || n > 2147483647) text = "Not a valid capacity. " + hint;
    else if (n < occupied)
      text =
        "Below the current Going count: " +
        occupied +
        " are already going. The save checks again and refuses a cap below it.";
    else if (n === occupied)
      text = "Full: " + occupied + " of " + n + " seats taken at the snapshot. " + hint;
    else text = n - occupied + " of " + n + " seats left at the snapshot. " + hint;
    advice.textContent = text;
  };
  input.addEventListener("input", update);
  // A restored draft (back/forward) differs from the saved cap: explain it now.
  if (input.value.trim() !== (snapshot.getAttribute("data-capacity") || "")) update();
})();
