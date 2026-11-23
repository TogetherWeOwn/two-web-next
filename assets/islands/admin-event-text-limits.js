const fieldLabels = {
  title: "the title",
  game: "the game",
  description: "the description",
  accessibility_notes: "accessibility notes",
  location: "the location",
  organizer_name: "the organizer name",
  join_instructions: "joining instructions",
};

// Native maxlength counts UTF-16 units; human event forms count trimmed
// canonical LF code points, independent of native POST CRLF serialization.
export function eventTextLimitError(value, field, limit) {
  const submitted = value.replace(/\r\n?/g, "\n").trim();
  return [...submitted].length > limit
    ? `Keep ${fieldLabels[field] ?? "this field"} to ${limit} characters.`
    : "";
}

const bound = new WeakSet();
export function bindAdminEventTextLimits(root = document) {
  for (const control of root.querySelectorAll(
    "input[data-event-text-limit], textarea[data-event-text-limit]",
  )) {
    if (bound.has(control)) continue;
    bound.add(control);
    const limit = Number(control.dataset.eventTextLimit);
    const describedBy = control.getAttribute("aria-describedby");
    const serverInvalid = control.getAttribute("aria-invalid");
    let error;
    // Keep the server's inline feedback until resubmission; enforce the live limit either way.
    if (!describedBy?.split(/\s+/).includes(`${control.id}-error`)) {
      error = control.ownerDocument.createElement("p");
      error.id = `${control.id}-limit-error`;
      error.className = "error";
      error.setAttribute("role", "alert");
      control.after(error);
      control.setAttribute("aria-describedby", [describedBy, error.id].filter(Boolean).join(" "));
    }
    const update = () => {
      const message = eventTextLimitError(control.value, control.name, limit);
      control.setCustomValidity(message);
      if (error) {
        error.textContent = message;
        error.hidden = !message;
      }
      if (message) control.setAttribute("aria-invalid", "true");
      else if (serverInvalid) control.setAttribute("aria-invalid", serverInvalid);
      else control.removeAttribute("aria-invalid");
    };
    control.addEventListener("input", update);
    control.addEventListener("change", update);
    control.form?.addEventListener("reset", () => queueMicrotask(update));
    update();
  }
}

if (typeof document !== "undefined") bindAdminEventTextLimits();
