// Native maxlength counts UTF-16 units; the server counts trimmed code points.
export function eventTextLimitError(value, field, limit) {
  return [...value.trim()].length > limit ? `Keep the ${field} to ${limit} characters.` : "";
}

const bound = new WeakSet();
export function bindAdminEventTextLimits(root = document) {
  for (const input of root.querySelectorAll("input[data-event-text-limit]")) {
    if (bound.has(input)) continue;
    bound.add(input);
    const limit = Number(input.dataset.eventTextLimit);
    const error = input.ownerDocument.createElement("p");
    error.id = `${input.id}-limit-error`;
    error.className = "error";
    error.setAttribute("role", "alert");
    input.after(error);
    const describedBy = input.getAttribute("aria-describedby");
    input.setAttribute("aria-describedby", [describedBy, error.id].filter(Boolean).join(" "));
    const serverInvalid = input.getAttribute("aria-invalid");
    const update = () => {
      const message = eventTextLimitError(input.value, input.name, limit);
      input.setCustomValidity(message);
      error.textContent = message;
      error.hidden = !message;
      if (message) input.setAttribute("aria-invalid", "true");
      else if (serverInvalid) input.setAttribute("aria-invalid", serverInvalid);
      else input.removeAttribute("aria-invalid");
    };
    input.addEventListener("input", update);
    input.addEventListener("change", update);
    input.form?.addEventListener("reset", () => queueMicrotask(update));
    update();
  }
}

if (typeof document !== "undefined") bindAdminEventTextLimits();
