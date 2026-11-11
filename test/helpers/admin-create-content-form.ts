import { expect } from "vitest";

export const fields = [
  {
    name: "accessibility_notes",
    id: "f-accessibility-notes",
    tag: "textarea",
    limit: 1000,
    label: "Accessibility notes",
    hint: "Optional; include only confirmed details, not personal contact information.",
    message: "Keep accessibility notes to 1000 characters.",
    value: "Step-free entrance; quiet room available.",
  },
  {
    name: "organizer_name",
    id: "f-organizer-name",
    tag: "input",
    limit: 500,
    label: "Organizer display name (optional)",
    hint: "Use a name the organizer has agreed to show publicly. Do not enter contact details.",
    message: "Keep the organizer name to 500 characters.",
    value: "Riley & friends",
  },
  {
    name: "join_url",
    id: "f-join-url",
    tag: "input",
    limit: 2048,
    label: "Public joining link (optional)",
    hint: "HTTPS or HTTP link visible to everyone. Never use attendee-only or private links.",
    message: "Keep the public joining link to 2048 characters.",
    value: "https://meet.example.test/lobby?room=9&mode=public",
  },
  {
    name: "join_instructions",
    id: "f-join-instructions",
    tag: "textarea",
    limit: 5000,
    label: "Public joining instructions (optional)",
    hint: "Share only verified details that are safe for anyone to see. Do not enter contact details.",
    message: "Keep joining instructions to 5000 characters.",
    value: "Use the public lobby.\nAsk the host for the next game.",
  },
] as const;
export const content = Object.fromEntries(fields.map((field) => [field.name, field.value]));
export const values = {
  title: "Public game night",
  game: "Chess",
  description: "Bring a board",
  starts_at: "2030-06-05 20:00",
  ends_at: "2030-06-05 22:00",
  timezone: "Europe/London",
  location: "Community voice",
  capacity: "8",
  recurrence_frequency: "weekly",
  recurrence_count: "3",
  recurrence_ends_on: "",
  ...content,
};

// This bounded HTML reader consumes rendered form controls, never Svelte source.
// It decodes values before URL encoding and uses native textarea CRLF submission.
// No expected content field is inserted by the serializer: missing markup loses it.
export function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[
      entity
    ]!;
  });
}
function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of tag.matchAll(/\s([\w:-]+)(?:="([^"]*)"|='([^']*)'|=([^\s>]+))?/g))
    out[match[1]!] = decode(match[2] ?? match[3] ?? match[4] ?? "");
  return out;
}
function controls(html: string) {
  return [
    ...html.matchAll(
      /<(input|textarea|select)\b((?:"[^"]*"|'[^']*'|[^'">])*)(?:>([\s\S]*?)<\/\1>|>)/g,
    ),
  ].map((match) => ({
    tag: match[1]!,
    attrs: attributes(` ${match[2]}`),
    body: match[3] ?? "",
  }));
}
export function control(html: string, name: string) {
  const found = controls(html).filter((entry) => entry.attrs.name === name);
  expect(found, `render one actual successful control named ${name}`).toHaveLength(1);
  return found[0]!;
}
export function nativeForm(html: string) {
  const form = /<form\b[^>]*>([\s\S]*?)<\/form>/.exec(html);
  expect(form, "real native create form").not.toBeNull();
  const attrs = attributes(form![0].slice(0, form![0].indexOf(">")));
  const body = new URLSearchParams();
  for (const entry of controls(form![1]!)) {
    const a = entry.attrs;
    if (!a.name || Object.hasOwn(a, "disabled")) continue;
    if (["submit", "button", "reset", "file"].includes(a.type ?? "")) continue;
    if (["checkbox", "radio"].includes(a.type ?? "") && !Object.hasOwn(a, "checked")) continue;
    if (entry.tag === "select") {
      const options = [...entry.body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)];
      const selected =
        options.find((option) => Object.hasOwn(attributes(` ${option[1]}`), "selected")) ??
        options[0];
      if (selected)
        body.append(a.name, attributes(` ${selected[1]}`).value ?? decode(selected[2]!));
    } else {
      const value = entry.tag === "textarea" ? decode(entry.body) : (a.value ?? "");
      body.append(a.name, entry.tag === "textarea" ? value.replace(/\r\n?|\n/g, "\r\n") : value);
    }
  }
  return { attrs, body };
}
