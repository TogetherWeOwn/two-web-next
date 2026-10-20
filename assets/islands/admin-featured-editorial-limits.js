// Admin featured editorial limits: advance budget feedback for the featured
// new/edit forms. Hono and Kit share this island (like admin-event-editor.js),
// so both renderers explain the same budgets the same way.
//
// The server validator (src/admin/validation-featured-form.ts) trims each
// value, then counts Unicode code points for headline/body/image description
// and UTF-16 units for the two URLs. featuredCountUsed mirrors that count
// exactly; the form shows the budget before Save instead of only refusing at
// Save. The island never blocks submission (no setCustomValidity: an
// over-budget draft must still POST and receive the server's 422 field
// errors), never truncates, never fetches, and never touches the homepage
// preview. Feedback nodes are plain hints, never a live region or alert, so
// typing is never announced keystroke by keystroke and the dirty-draft /
// repeated-submit guard keeps sole ownership of navigation and submit.
//
// Node insertion waits for DOMContentLoaded (after deferred scripts and Kit
// hydration, which adopt the pristine server DOM); event binding runs
// immediately and mutates nothing, so it is safe either way.
export function featuredCountUsed(value, units) {
  const trimmed = String(value ?? "").trim();
  return units === "utf16" ? trimmed.length : [...trimmed].length;
}

function unitWord(units) {
  return units === "utf16" ? "UTF-16 units" : "code points";
}

export function featuredCountText(used, limit, units, missingAlt) {
  const base = `${used} of ${limit} ${unitWord(units)} used.`;
  if (missingAlt) return `${base} A description is required while an image URL is set.`;
  if (used > limit) return `${base} ${used - limit} over the limit.`;
  return base;
}

function describedWith(control, id) {
  const tokens = String(control.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.includes(id)) tokens.push(id);
  control.setAttribute("aria-describedby", tokens.join(" "));
}

const bound = new WeakSet();

function ensureNode(control) {
  const id = `${control.id}-count`;
  const existing = control.ownerDocument.getElementById(id);
  if (existing) {
    describedWith(control, id);
    return existing;
  }
  const node = control.ownerDocument.createElement("p");
  node.id = id;
  node.className = "hint";
  const field = control.closest(".field");
  const hint = field?.querySelector("p.hint");
  if (hint) hint.after(node);
  else control.after(node);
  describedWith(control, id);
  return node;
}

function controlsOf(form) {
  return [...form.querySelectorAll("input[data-featured-limit], textarea[data-featured-limit]")];
}

function updateControl(control) {
  const limit = Number(control.dataset.featuredLimit);
  const units = control.dataset.featuredUnits;
  const used = featuredCountUsed(control.value, units);
  const form = control.form;
  const imageUrl = form?.querySelector('[name="image_url"]');
  const missingAlt =
    control.name === "image_alt" &&
    (imageUrl?.value ?? "").trim() !== "" &&
    control.value.trim() === "";
  ensureNode(control).textContent = featuredCountText(used, limit, units, missingAlt);
}

function updateForm(form) {
  for (const control of controlsOf(form)) updateControl(control);
}

export function bindAdminFeaturedEditorialLimits(root = document) {
  const forms = new Set();
  for (const control of root.querySelectorAll(
    "form[data-event-editor] input[data-featured-limit], form[data-event-editor] textarea[data-featured-limit]",
  )) {
    if (bound.has(control)) continue;
    bound.add(control);
    const form = control.form;
    if (form && !forms.has(form)) {
      forms.add(form);
      form.addEventListener("input", () => updateForm(form));
      form.addEventListener("change", () => updateForm(form));
      form.addEventListener("reset", () => queueMicrotask(() => updateForm(form)));
    }
  }
  // Insert feedback nodes after deferred scripts and Kit hydration, which
  // adopt the pristine server DOM. Updates also ensure their node, so a
  // first keystroke before this fires still renders feedback.
  const insert = () => {
    for (const control of root.querySelectorAll(
      "form[data-event-editor] input[data-featured-limit], form[data-event-editor] textarea[data-featured-limit]",
    ))
      updateControl(control);
  };
  if (typeof document !== "undefined" && root === document) {
    if (document.readyState === "loading" || document.readyState === "interactive") {
      document.addEventListener("DOMContentLoaded", insert, { once: true });
    } else {
      insert();
    }
  } else {
    insert();
  }
}

if (typeof document !== "undefined") bindAdminFeaturedEditorialLimits();
