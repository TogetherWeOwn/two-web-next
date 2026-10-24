import { expect } from "vitest";

export const editableEventFields = [
  "title",
  "game",
  "description",
  "starts_at",
  "ends_at",
  "timezone",
  "location",
  "capacity",
] as const;

function decode(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number(entity.slice(1)));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[
      entity
    ]!;
  });
}

export function attributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    Array.from(tag.matchAll(/([^\s=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g), (m) => [
      m[1]!,
      decode(m[2] ?? m[3] ?? m[4] ?? ""),
    ]),
  );
}

export function savedForm(html: string) {
  const form = Array.from(html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)).find((m) =>
    m[2]!.includes('data-testid="save-event"'),
  );
  expect(form, "the rendered document contains the actual Save form").toBeDefined();
  const fields: Record<string, string> = {};
  const hidden: Record<string, string> = {};
  for (const match of form![2]!.matchAll(/<input\b([^>]*)>/g)) {
    const attrs = attributes(match[1]!);
    if (!attrs.name || "disabled" in attrs) continue;
    if (attrs.type === "checkbox" && (!("checked" in attrs) || attrs.checked === "false")) continue;
    if (["submit", "button", "reset"].includes(attrs.type ?? "")) continue;
    fields[attrs.name] = attrs.value ?? (attrs.type === "checkbox" ? "on" : "");
    if (attrs.type === "hidden") hidden[attrs.name] = fields[attrs.name]!;
  }
  for (const match of form![2]!.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
    const attrs = attributes(match[1]!);
    if (attrs.name) fields[attrs.name] = decode(match[2]!);
  }
  return { fields, hidden, attrs: attributes(form![1]!) };
}

export function draftFields(fields: Record<string, string>): Record<string, string> {
  return Object.fromEntries(editableEventFields.map((name) => [name, fields[name] ?? ""]));
}

export function reviewCurrentHref(html: string, key: string): string {
  const link = Array.from(html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)).find((match) => {
    const attrs = attributes(match[1]!);
    const text = decode(match[2]!.replace(/<[^>]+>/g, " "));
    return attrs.href === `/admin/events/${key}` && /review|current|latest/i.test(text);
  });
  expect(link, "a named native link explicitly reviews the saved version").toBeDefined();
  const attrs = attributes(link![1]!);
  expect(attrs.tabindex ?? "0").not.toMatch(/^-/);
  expect(attrs["aria-disabled"]).not.toBe("true");
  expect(html).toMatch(/changed|stale|conflict|another|newer/i);
  return attrs.href!;
}
