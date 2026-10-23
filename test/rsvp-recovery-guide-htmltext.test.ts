// Helper regression: visible-text extraction behind the RSVP recovery FAQ
// acceptance. Script/style bodies must never leak into the asserted text,
// including whitespace-bearing and mixed-case closing tags.
import { describe, expect, it } from "vitest";
import { htmlText } from "./helpers/rsvp-recovery-guide";

describe("rsvp recovery guide htmlText", () => {
  it("extracts normal FAQ body text with entities decoded", () => {
    const text = htmlText(
      '<h2 id="q">Going &amp; seats</h2><p>A seat, not measured attendance. ' +
        "Don&#x27;t rely on delivery &quot;alerts&quot; &amp; check the event.</p>",
    );
    expect(text).toBe(
      'Going & seats A seat, not measured attendance. Don\'t rely on delivery "alerts" & check the event.',
    );
  });

  it("ignores script and style bodies", () => {
    const text = htmlText(
      "<p>Keep this</p>" +
        '<script>document.write("drop");</script>' +
        "<style>.q{display:none}</style>" +
        "<p>And this</p>",
    );
    expect(text).toBe("Keep this And this");
  });

  it("ignores script and style bodies with whitespace-bearing closing tags", () => {
    const text = htmlText(
      "<p>Keep this</p>" +
        '<script>alert("drop");</script ><style>.q{color:red}</style  ><p>And this</p>',
    );
    expect(text).toBe("Keep this And this");
  });

  it("ignores script and style bodies regardless of tag case", () => {
    const text = htmlText(
      "<p>Keep this</p>" +
        "<SCRIPT>var drop = 1;</SCRIPT><Style>.q{color:red}</STYLE><p>And this</p>",
    );
    expect(text).toBe("Keep this And this");
  });

  it("keeps attribute values containing > out of the visible text", () => {
    expect(htmlText('<a title="a>b">link</a>')).toBe("link");
  });

  it("drops comments and keeps a stray angle bracket as text", () => {
    expect(htmlText("a<!-- hidden -->b")).toBe("a b");
    expect(htmlText("2 < 3 and 4 > 1")).toBe("2 < 3 and 4 > 1");
  });

  it("decodes entities in a single pass with &amp; last", () => {
    expect(htmlText("<p>&amp;quot; &#39; &apos;</p>")).toBe("&quot; ' '");
  });
});
