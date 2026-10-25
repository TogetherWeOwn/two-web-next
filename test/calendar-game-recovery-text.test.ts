import { describe, expect, it } from "vitest";
import { broadeningLinks, decodedText } from "./helpers/calendar-game-recovery";

// Catches cascaded entity decoding and hidden fixture content leaking into the
// text used by recovery assertions. These helpers are not HTML sanitizers.
describe("calendar recovery fixture text", () => {
  it.each([
    ["<p>Chess &amp; Go: &#39;night&#x27; &quot;games&quot;</p>", "Chess & Go: 'night' \"games\""],
    ["&amp;quot; &amp;#39; &amp;#x27; &amp;amp;", "&quot; &#39; &#x27; &amp;"],
    ["&unknown; &lt;script&gt; &amp", "&unknown; &lt;script&gt; &amp"],
    ["<p>Chess</p>\n<p> Go\t night </p>", "Chess Go night"],
    ['<p title="not > visible">Chess</p>', "Chess"],
    ["<p title='not > visible'>Chess</p>", "Chess"],
    ["Chess<!-- hidden > marker -->Go", "Chess Go"],
    ["Chess<script>hidden marker</script >Go", "Chess Go"],
    ["İ<script>hidden marker</script >Go", "İ Go"],
    ["Chess<STYLE>hidden marker</STYLE\t>Go", "Chess Go"],
    ["Chess<ScRiPt data-x='>'>one</scripture>two</sCrIpT\n>Go", "Chess Go"],
    ["Chess<style>one</stylesheet>two</style>Go", "Chess Go"],
    ["<script>hidden only</script>", ""],
    ["Chess<script>unclosed hidden marker", "Chess"],
    ["", ""],
  ])("extracts comparison text from %j", (html, expected) => {
    expect(decodedText(html)).toBe(expected);
  });

  it("keeps recovery destination and label text independent", () => {
    expect(
      broadeningLinks(
        '<a href="/events?view=list&amp;past=1">All games &amp;quot;Chess&amp;quot;</a>',
      ),
    ).toEqual([{ href: "/events?view=list&past=1", name: "All games &quot;Chess&quot;" }]);
  });
});
