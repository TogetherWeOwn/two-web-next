// Acceptance-owned parser regressions: literal entities must not be decoded twice,
// and removing a comment must not create another token to strip from the label.
import { describe, expect, it } from "vitest";
import { currentMark, namedLink, seasonInput } from "./helpers/member-board-period-shortcuts";

describe("member-board shortcut fixture parsing", () => {
  it.each([
    ["&amp;", "&"],
    ["&#39;", "'"],
    ["&#x27;", "'"],
    ["&#X27;", "'"],
    ["&quot;", '"'],
    ["&amp;#39;", "&#39;"],
    ["&amp;#x27;", "&#x27;"],
    ["&amp;quot;", "&quot;"],
    ["&amp;amp;", "&amp;"],
  ])("decodes %s exactly once in href and historical input", (encoded, literal) => {
    const href = `/leaderboards/members?activity=${encoded}&scope=relative`;
    expect(namedLink(`<a href="${href}">This month</a>`, "This month").href).toBe(
      `/leaderboards/members?activity=${literal}&scope=relative`,
    );
    expect(seasonInput(`<input name="season" value="${encoded}">`).value).toBe(literal);
  });

  it("decodes text once without reinterpreting an encoded entity or tag", () => {
    expect(namedLink('<a href="/">Mick&#39;s &amp; game</a>', "Mick's & game").name).toBe(
      "Mick's & game",
    );
    expect(namedLink('<a href="/">&amp;#39;</a>', "&#39;").name).toBe("&#39;");
    expect(namedLink('<a href="/">&lt;span&gt;</a>', "&lt;span&gt;").name).toBe("&lt;span&gt;");
  });

  it.each([
    "This <!--[-->month<!--]-->",
    "<!--before-->This <!-- <span>not label text</span> -->month<!--after-->",
    "<span>This</span><strong>month</strong>",
    "  This\n\t month  ",
  ])("extracts exact text from original comment/tag tokens: %s", (label) => {
    const link = namedLink(`<a href="/leaderboards/members">${label}</a>`, "This month");
    expect(link.href).toBe("/leaderboards/members");
    expect(link.name).toBe("This month");
  });

  it("does not reinterpret a comment opener assembled by stripping an earlier comment", () => {
    expect(() =>
      namedLink('<a href="/">This <<!--marker-->!--hidden-->month</a>', "This month"),
    ).toThrow("Expected one native This month shortcut/link");
  });

  it.each([
    "",
    '<a href="/">This quarter</a>',
    '<a href="/">This month extra</a>',
    "<button>This month</button>",
    '<a href="/">This month</a><a href="/other">This month</a>',
  ])("retains exact native-anchor cardinality for %j", (html) => {
    expect(() => namedLink(html, "This month")).toThrow(
      "Expected one native This month shortcut/link",
    );
  });

  it.each(['href=""', 'href="#"', 'href="javascript:void(0)"'])(
    "refuses a non-navigable href: %s",
    (attrs) => {
      expect(() => namedLink(`<a ${attrs}>This month</a>`, "This month")).toThrow(
        "This month needs a navigable href",
      );
    },
  );

  it.each(['onclick="navigate()"', 'role="button"'])(
    "retains the native-link attribute guard for %s",
    (attrs) => {
      expect(() => namedLink(`<a href="/" ${attrs}>This month</a>`, "This month")).toThrow(
        "This month must remain a native link",
      );
    },
  );

  it("retains raw attrs for the selected-period and historical-input assertions", () => {
    const attrs = ' href="/" aria-current="date" data-control="unchanged"';
    expect(namedLink(`<a${attrs}>This month</a>`, "This month").attrs).toBe(attrs);
    expect(currentMark(attrs)).toBe(true);
    expect(currentMark('aria-current="false"')).toBe(false);
    expect(seasonInput('<input name="season" value="2024-Q3" readonly>').attrs).toBe(
      ' name="season" value="2024-Q3" readonly',
    );
  });
});
