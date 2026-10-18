// Native maxlength counts UTF-16 units; the server counts trimmed code points.
export function eventTextLimitError(value, field, limit) {
  return [...value.trim()].length > limit ? `Keep the ${field} to ${limit} characters.` : "";
}

const bound = new WeakSet();
export function bindAdminEventTextLimits(root = document) {
  for (const control of root.querySelectorAll(
    "input[data-event-text-limit], textarea[data-event-text-limit]",
  )) {
    if (bound.has(control)) continue;
    bound.add(control);
    const limit = Number(control.dataset.eventTextLimit);
    const error = control.ownerDocument.createElement("p");
    error.id = `${control.id}-limit-error`;
    error.className = "error";
    error.setAttribute("role", "alert");
    control.after(error);
    const describedBy = control.getAttribute("aria-describedby");
    control.setAttribute("aria-describedby", [describedBy, error.id].filter(Boolean).join(" "));
    const serverInvalid = control.getAttribute("aria-invalid");
    const update = () => {
      const message = eventTextLimitError(control.value, control.name, limit);
      control.setCustomValidity(message);
      error.textContent = message;
      error.hidden = !message;
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
