// S1 link-in-bio validation (spec section 9, S1): at most 12 member links,
// each a trimmed label (non-blank, <= 80 chars, mirroring games) plus a
// trimmed https URL (<= 2048 chars) outside the malicious-host denylist.
// Both save shapes share the item rules: PATCH takes JSON `{ links: [...] }`
// (whole-list replace), POST takes native form `links_text` (one link per
// line as `Label | https://...`, split on the first `|`). Error keys mirror
// the profile write contract: `links` for list-level failures,
// `links[i].field` for item-level failures.

import type { MemberLink } from "./links-store";

export const MEMBER_LINKS_MAX = 12;
export const MEMBER_LINK_LABEL_MAX = 80;
export const MEMBER_LINK_URL_MAX = 2048;
/** Lowercase hosts refused exactly and on any subdomain (case-insensitive). */
export const MEMBER_LINK_DENYLIST = ["blocked-example.test"];

// Match the MemberProfile browser policy; tab, LF and CR remain allowed.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export type LinksResult =
  | { ok: true; links: MemberLink[] }
  | { ok: false; errors: Record<string, string> };

const linkItemError = (
  item: unknown,
  index: number,
): { link?: MemberLink; errors: Record<string, string> } => {
  const errors: Record<string, string> = {};
  if (typeof item !== "object" || item === null || Array.isArray(item)) {
    errors[`links[${index}]`] = "Each link must have a label and a URL.";
    return { errors };
  }
  const record = item as Record<string, unknown>;
  let label: string | null = null;
  const labelRaw = record.label;
  if (typeof labelRaw !== "string") {
    errors[`links[${index}].label`] =
      labelRaw === undefined || labelRaw === null
        ? "Label must not be blank."
        : "Label must be text.";
  } else if (CONTROL_CHARS.test(labelRaw)) {
    errors[`links[${index}].label`] = "Remove control characters.";
  } else if (labelRaw.trim() === "") {
    errors[`links[${index}].label`] = "Label must not be blank.";
  } else if ([...labelRaw.trim()].length > MEMBER_LINK_LABEL_MAX) {
    errors[`links[${index}].label`] = "Keep each label to 80 characters or fewer.";
  } else {
    label = labelRaw.trim();
  }
  let url: string | null = null;
  const urlRaw = record.url;
  if (typeof urlRaw !== "string") {
    errors[`links[${index}].url`] =
      urlRaw === undefined || urlRaw === null ? "URL must not be blank." : "URL must be text.";
  } else if (CONTROL_CHARS.test(urlRaw)) {
    errors[`links[${index}].url`] = "Remove control characters.";
  } else if (urlRaw.trim() === "") {
    errors[`links[${index}].url`] = "URL must not be blank.";
  } else if ([...urlRaw.trim()].length > MEMBER_LINK_URL_MAX) {
    errors[`links[${index}].url`] = "Keep each URL to 2048 characters or fewer.";
  } else {
    const trimmed = urlRaw.trim();
    let host: string | null = null;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "https:") host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    } catch {
      host = null;
    }
    if (host === null) {
      errors[`links[${index}].url`] = "Links must use https.";
    } else if (
      MEMBER_LINK_DENYLIST.some((seed) => host === seed || host.endsWith(`.${seed}`))
    ) {
      errors[`links[${index}].url`] = "That link host is not allowed.";
    } else {
      // Store the trimmed original, never the URL-normalized href (which
      // would append slashes and re-encode what the member typed).
      url = trimmed;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return { errors, link: { label: label!, url: url! } };
};

export function validateLinksList(raw: unknown): LinksResult {
  if (!Array.isArray(raw)) return { ok: false, errors: { links: "Links must be a list." } };
  if (raw.length > MEMBER_LINKS_MAX)
    return { ok: false, errors: { links: "Add no more than 12 links." } };
  const errors: Record<string, string> = {};
  const links: MemberLink[] = [];
  raw.forEach((item, index) => {
    const result = linkItemError(item, index);
    Object.assign(errors, result.errors);
    if (result.link) links.push(result.link);
  });
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, links };
}

const WRITABLE_FIELDS = new Set(["links"]);

export function validateLinksJson(input: Record<string, unknown>): LinksResult {
  const unknown = Object.keys(input).filter((key) => !WRITABLE_FIELDS.has(key));
  if (unknown.length > 0) {
    const errors: Record<string, string> = {};
    for (const key of unknown) errors[key] = `Unknown field "${key}". Only "links" can be changed.`;
    return { ok: false, errors };
  }
  return validateLinksList(input.links);
}

export function parseLinksFormText(value: unknown): LinksResult {
  // Absent or blank clears the list, like the profile games blanking rule.
  if (value === undefined || value === null) return { ok: true, links: [] };
  if (typeof value !== "string")
    return { ok: false, errors: { links_text: "Links text must be text." } };
  const items: unknown[] = [];
  const errors: Record<string, string> = {};
  let index = 0;
  for (const line of value.split(/\r\n|\r|\n/)) {
    if (line.trim() === "") continue;
    const pipe = line.indexOf("|");
    if (pipe === -1) {
      errors[`links[${index}]`] = `Line ${index + 1} needs "Label | https://...".`;
      index += 1;
      continue;
    }
    items.push({ label: line.slice(0, pipe), url: line.slice(pipe + 1) });
    index += 1;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return validateLinksList(items);
}
