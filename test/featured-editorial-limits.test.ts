// Test Author owned: removing advance guidance, losing a hint during error
// rendering, or counting UTF-16/graphemes instead of trimmed code points fails.
// Intentionally RED until the paired implementation; do not weaken these tests.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgets,
  compileKitForms,
  documentFixture,
  errorsFor,
  fields,
  saved,
  textCases,
  urlCases,
  type Compiler,
  type Field,
} from "./helpers/featured-editorial-fixtures";

let compiler: Compiler;
beforeAll(async () => {
  compiler = await compileKitForms();
});
afterAll(() => compiler?.dispose());

function control(html: string, field: Field) {
  const tag = [...html.matchAll(/<(?:input|textarea)\b[^>]*>/g)]
    .map((match) => match[0])
    .find((tag) => tag.includes(`name="${field}"`));
  expect(tag, `${field} remains an editable control`).toBeDefined();
  return tag!;
}
function hintNodes(html: string, field: Field) {
  const tag = control(html, field);
  const ids = /aria-describedby="([^"]*)"/.exec(tag)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  return ids
    .filter((id) => !id.endsWith("-error"))
    .map((id) => {
      const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(
        `<([a-z][\\w-]*)\\b[^>]*\\bid="${escaped}"[^>]*>([\\s\\S]*?)<\\/\\1>`,
      ).exec(html);
      expect(match, `${field} hint ${id} resolves in the no-JS document`).not.toBeNull();
      expect(match![0]).not.toMatch(/\bhidden(?:\s|=|>)|aria-hidden="true"/);
      return { id, text: match![2]!.replace(/<[^>]*>/g, " "), tag: match![0] };
    });
}

for (const surface of ["Hono", "Kit"] as const) {
  for (const mode of ["new", "edit"] as const) {
    describe(`${surface} featured ${mode} advance guidance`, () => {
      for (const field of fields) {
        it(`${field} exposes its persistent associated budget before Save without JavaScript`, async () => {
          const { html } = await documentFixture(compiler, surface, mode);
          const hints = hintNodes(html, field);
          const text = hints.map((hint) => hint.text).join(" ");
          expect(text, `${field} has advance limit guidance`).toMatch(
            new RegExp(`\\b${budgets[field]}\\b`),
          );
          expect(text).toMatch(
            field === "url" || field === "image_url" ? /UTF[ -]?16/i : /code[ -]?points?/i,
          );
          expect(text).not.toMatch(/(?:limit|maximum|up to)\s+(?:of\s+)?\d+\s+graphemes?/i);
          expect(control(html, field)).not.toMatch(/\bmaxlength\s*=/i);
        });
      }
      it("retains image-host admission and conditional screen-reader description policy", async () => {
        const { html } = await documentFixture(compiler, surface, mode);
        expect(
          hintNodes(html, "image_url")
            .map((hint) => hint.text)
            .join(" "),
        ).toMatch(/HTTPS.*approved|approved.*host/i);
        const alt = hintNodes(html, "image_alt")
          .map((hint) => hint.text)
          .join(" ");
        expect(alt).toMatch(/screen.reader/i);
        expect(alt).toMatch(
          /(?:required|describe|description).*(?:image|photo)|(?:image|photo).*(?:required|describe|description)/i,
        );
        expect(html).toMatch(
          new RegExp(
            `<form\\b[^>]*method="post"[^>]*action="${mode === "new" ? "/admin/featured" : "/admin/featured/7"}"`,
          ),
        );
      });
    });
  }
}

for (const mode of ["new", "edit"] as const) {
  it(`Hono ${mode}: rejected values retain the same hint IDs alongside every field error`, async () => {
    const values = {
      ...saved,
      title: "😀".repeat(256),
      body: "x".repeat(1001),
      image_alt: "x".repeat(256),
      url: urlCases("url")[1]!.value,
      image_url: urlCases("image_url")[1]!.value,
    };
    const errors = errorsFor(values);
    expect(Object.keys(errors).sort()).toEqual([...fields].sort());
    const clean = await documentFixture(compiler, "Hono", mode, saved);
    const rejected = await documentFixture(compiler, "Hono", mode, values, errors);
    for (const field of fields) {
      const original = hintNodes(clean.html, field).map((hint) => hint.id);
      expect(original.length, `${field} has a persistent hint`).toBeGreaterThan(0);
      expect(hintNodes(rejected.html, field).map((hint) => hint.id)).toEqual(original);
      expect(control(rejected.html, field)).toContain('aria-invalid="true"');
      expect(control(rejected.html, field)).toMatch(/aria-describedby="[^"]*-error/);
      expect(rejected.html).toContain(errors[field]);
    }
  });
}

describe("independent validator oracle for editorial feedback", () => {
  for (const field of ["title", "body", "image_alt"] as const) {
    it.each(textCases(budgets[field]))(`${field}: $label`, ({ value, used, over }) => {
      expect([...value.trim()]).toHaveLength(used);
      expect(Boolean(errorsFor({ ...saved, [field]: value })[field])).toBe(over);
    });
  }
  for (const field of ["url", "image_url"] as const) {
    it.each(urlCases(field))(`${field}: $label`, ({ value, used, over, refusal }) => {
      expect(value.trim().length).toBe(used);
      const error = errorsFor({ ...saved, [field]: value })[field];
      // A refused link keeps its exact copy; otherwise only the length decides.
      expect(refusal ? error : Boolean(error)).toBe(refusal ?? over);
    });
  }
  it("requires alt only while an image URL is present, and trims whitespace", () => {
    expect(errorsFor({ ...saved, image_url: "", image_alt: " \t  " })).toEqual({});
    expect(Object.keys(errorsFor({ ...saved, image_alt: " \t  " }))).toEqual(["image_alt"]);
    expect(errorsFor({ ...saved, image_alt: " é😀 " })).toEqual({});
  });
});
