// Catastrophic failures must retain the status but never echo exception text.
// Browser semantics, offline recovery and presentation live in the ungated
// e2e/kit-catastrophic-fallback.spec.ts, not in source-string approximations.
import { defaultTreeAdapter, parse } from "parse5";
import { describe, expect, it } from "vitest";
import {
  catastrophicTemplate,
  privateFailureMessages,
  renderCatastrophicFallback,
} from "./helpers/kit-catastrophic-fallback";
import { attr, elements, textOf } from "./helpers/kit-edit-controls";
import { decodedOutput } from "./helpers/refused-edit-roster";

describe("Kit catastrophic-error fallback", () => {
  it("retains status substitution without admitting the raw exception token", () => {
    expect(catastrophicTemplate).toContain("%sveltekit.status%");
    expect(catastrophicTemplate).not.toContain("%sveltekit.error.message%");
  });

  it("stays a standalone English UTF-8 document", () => {
    const page = parse(catastrophicTemplate, { sourceCodeLocationInfo: true });
    const doctype = page.childNodes.find(defaultTreeAdapter.isDocumentTypeNode);
    expect(doctype).toMatchObject({
      name: "html",
      publicId: "",
      systemId: "",
    });
    expect(page.mode).toBe("no-quirks");
    // parse5 can recover malformed declarations while still using standards mode.
    const location = doctype?.sourceCodeLocation;
    expect(
      location &&
        catastrophicTemplate.slice(location.startOffset, location.endOffset).toLowerCase(),
    ).toBe("<!doctype html>");
    const html = elements(page).find((element) => element.tagName === "html");
    expect(html && attr(html, "lang")).toBe("en");
    const charset = elements(page).find(
      (element) => element.tagName === "meta" && attr(element, "charset") !== undefined,
    );
    expect(charset && attr(charset, "charset")?.toLowerCase()).toBe("utf-8");
  });

  for (const status of [500, 503]) {
    it(`${status}: substitutes a real status into the fallback document`, () => {
      const html = renderCatastrophicFallback(status, "fixture-only failure");
      const headings = elements(parse(html)).filter((element) => element.tagName === "h1");
      expect(html).not.toContain("%sveltekit.status%");
      expect(headings.map(textOf)).toEqual([`${status}: Page unavailable`]);
    });
  }

  for (const [index, message] of privateFailureMessages.entries()) {
    it(`hostile message ${index + 1}: output is independent of private error details`, () => {
      const html = renderCatastrophicFallback(500, message);
      const output = decodedOutput(html);
      const nodes = elements(parse(html));
      const attributes = nodes.flatMap((element) => element.attrs.map(({ value }) => value));
      for (const marker of [
        "TEST_ONLY_PRIVATE_DETAIL",
        "private-fixture.invalid",
        "leak.invalid",
      ]) {
        // Raw bytes can ship private values even when parsing discards them.
        expect(html).not.toContain(marker);
        expect(output).not.toContain(marker);
        expect(attributes.some((value) => value.includes(marker))).toBe(false);
      }
      expect(nodes.filter(({ tagName }) => ["img", "script"].includes(tagName))).toEqual([]);
      // Byte equality also catches message-dependent output discarded by the parser.
      expect(html).toBe(renderCatastrophicFallback(500, "a different private failure"));
    });
  }
});
