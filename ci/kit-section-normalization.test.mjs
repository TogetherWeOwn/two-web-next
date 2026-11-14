import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { assertEmberArchive } from "./kit-archive-delta.mjs";
import {
  normalizeSection as contractNormalize,
  sectionOf as contractSectionOf,
  stripHydrationMarkers as contractStrip,
} from "./kit-section-contract.mjs";

// The parity normalization exists twice by hand-synced comment:
// ci/kit-section-contract.mjs (importable) and ci/kit-preview-e2e.mjs
// (runs on import, so no test can import its copy directly). This file pins
// behavioral agreement between the two copies on a fixture matrix. The e2e
// copy is reached without executing the script by extracting its three
// function declarations (anchored, brace-matched, fail-closed) into a scratch
// module that is dynamically imported; if the e2e copy is renamed or
// restructured, extraction throws instead of silently passing.
const e2eSource = readFileSync(new URL("./kit-preview-e2e.mjs", import.meta.url), "utf8");

function extractBlock(source, anchor) {
  const starts = [];
  let from = 0;
  while (true) {
    const index = source.indexOf(anchor, from);
    if (index < 0) break;
    starts.push(index);
    from = index + 1;
  }
  assert.equal(
    starts.length,
    1,
    `expected exactly one ${JSON.stringify(anchor)} in kit-preview-e2e.mjs`,
  );
  let depth = 0;
  let end = -1;
  for (let i = starts[0] + anchor.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, `unterminated block for ${JSON.stringify(anchor)}`);
  if (source[end] === ";") end++;
  return source.slice(starts[0], end);
}

const scratchDir = mkdtempSync(
  join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "kit-section-normalization-"),
);
after(() => rmSync(scratchDir, { recursive: true, force: true }));
const scratchPath = join(scratchDir, "e2e-normalization.mjs");
writeFileSync(
  scratchPath,
  `${extractBlock(e2eSource, "function stripHydrationMarkers(html) {")}\n` +
    `${extractBlock(e2eSource, "function normalize(html) {")}\n` +
    `${extractBlock(e2eSource, "const sectionOf = (html) => {")}\n` +
    "export { stripHydrationMarkers as e2eStrip, normalize as e2eNormalize, sectionOf as e2eSectionOf };\n",
);
const { e2eStrip, e2eNormalize, e2eSectionOf } = await import(pathToFileURL(scratchPath).href);
assert.equal(typeof e2eStrip, "function");
assert.equal(typeof e2eNormalize, "function");
assert.equal(typeof e2eSectionOf, "function");

function agree(label, input, golden) {
  const contract = contractNormalize(input);
  const e2e = e2eNormalize(input);
  assert.equal(e2e, contract, `${label}: copies disagree`);
  if (golden !== undefined) assert.equal(contract, golden, `${label}: golden mismatch`);
}

function agreeStrip(label, input, golden) {
  const contract = contractStrip(input);
  const e2e = e2eStrip(input);
  assert.equal(e2e, contract, `${label}: copies disagree`);
  if (golden !== undefined) assert.equal(contract, golden, `${label}: golden mismatch`);
}

test("hydration markers: simple, nested, and splice-together agree", () => {
  agreeStrip("simple marker pair", "<div><!--[0--><p>x</p><!--]--></div>", "<div><p>x</p></div>");
  agreeStrip(
    "nested marker pairs",
    "<div><!--[1--><!--[2--><p>x</p><!--]--><!--]--></div>",
    "<div><p>x</p></div>",
  );
  // Fixed-point proof: a single global replace leaves `<!--[-->` behind
  // (the inner removal splices a fresh marker together), so the loop must run
  // to a fixed point.
  agreeStrip("spliced marker needs the fixed point", "<!--[" + "<!--]-->" + "-->", "");
  agreeStrip("dash-only marker", "<!--[--->", "");
  // Only hydration markers strip: a bare Svelte empty comment survives both
  // copies (callers remove it separately before normalizing).
  agreeStrip("bare empty comment survives", "<div><!----></div>", "<div><!----></div>");
});

test("boolean attributes: bare, empty, and true agree on presence", () => {
  for (const input of ["<input disabled>", '<input disabled="">', '<input disabled="true">']) {
    agree(`boolean serialization of ${input}`, input, "<input disabled>");
  }
  agree("selected true", '<option selected="true">x</option>', "<option selected>x</option>");
  // Whitespace-lookahead proof: ="" and ="true" followed by another attribute
  // (routine serializer output) must strip, pinning the \s alternative of
  // (?=[\s>]) — not just the > alternative every other fixture exercises.
  agree(
    "empty/true before another attribute",
    '<span data-avatar="" aria-hidden="true" class="avatar">x</span>',
    '<span data-avatar aria-hidden class="avatar">x</span>',
  );
  agree(
    "non-boolean values survive",
    '<input value="false" aria-checked="false" title="a=true">',
    '<input value="false" aria-checked="false" title="a=true">',
  );
  agree(
    "true-prefix value survives",
    '<div data-x="trueish">x</div>',
    '<div data-x="trueish">x</div>',
  );
});

test("escapes: only &gt; is serializer-owned", () => {
  agree("gt unescapes", "<p>a &gt; b</p>", "<p>a > b</p>");
  agree(
    "security-relevant escapes survive exactly",
    "<p>&amp; &lt; &quot; &#39;</p>",
    "<p>&amp; &lt; &quot; &#39;</p>",
  );
  agree("amp-gt is not double-unescaped", "<p>&amp;gt;</p>", "<p>&amp;gt;</p>");
});

test("inter-tag whitespace collapses; text whitespace and edges trim", () => {
  agree(
    "spaces, newlines, and tabs between tags",
    "<div>   <p>x</p>\n\t<span>y</span>  </div>",
    "<div><p>x</p><span>y</span></div>",
  );
  agree("intra-text whitespace survives", "<p>hello   world</p>", "<p>hello   world</p>");
  agree("leading and trailing whitespace trims", "  <div>x</div>\n", "<div>x</div>");
});

test("missing section: both copies throw", () => {
  const doc = "<div>no section here</div>";
  assert.throws(() => contractSectionOf(doc, "past-events"), /section past-events is missing/);
  assert.throws(() => e2eSectionOf(doc), /Archive section is missing/);
});

test("present section: contract and e2e pipelines agree byte-for-byte", () => {
  const doc =
    "<html><body>\n" +
    '  <section data-testid="past-events">\n' +
    '    <!--[0--><div data-testid="past-events-list">\n' +
    '      <article data-event-key="kit-parity-1" hidden="">Parity night &lt;&amp;&gt; 1</article>\n' +
    "    </div><!--]-->\n" +
    "  </section>\n" +
    "</body></html>";
  const contract = contractSectionOf(doc, "past-events");
  const e2e = e2eNormalize(e2eSectionOf(doc));
  assert.equal(e2e, contract);
  assert.equal(
    contract,
    '<section data-testid="past-events"><div data-testid="past-events-list">' +
      '<article data-event-key="kit-parity-1" hidden>Parity night &lt;&amp;> 1</article>' +
      "</div></section>",
  );
  // Attribute-prefix + sibling proof: the real Hono archive section emits
  // data-island before data-testid, and real pages are multi-section, so
  // [^>]* must span leading attributes and [\s\S]*? must stop at the first
  // closing tag — a lone testid-first section pins neither branch.
  const multiDoc =
    '<section data-island="past-events" data-testid="past-events">A</section>' +
    '<section data-testid="other">B</section>';
  const multiContract = contractSectionOf(multiDoc, "past-events");
  const multiE2e = e2eNormalize(e2eSectionOf(multiDoc));
  assert.equal(multiE2e, multiContract);
  assert.equal(
    multiContract,
    '<section data-island="past-events" data-testid="past-events">A</section>',
  );
});

test("differently-testid sections: contract finds them, the fixed e2e copy throws", () => {
  const doc = '<section data-testid="other">x</section>';
  assert.equal(contractSectionOf(doc, "other"), '<section data-testid="other">x</section>');
  const deltaLike = '<section data-testid="other"><svg class="state-glyph"></svg></section>';
  assert.equal(
    contractSectionOf(deltaLike, "other", { kit: true }),
    contractSectionOf(deltaLike, "other"),
  );
  assert.throws(() => e2eSectionOf(doc), /Archive section is missing/);
});

// Archive-only Ember delta: Kit raw markup is validated exactly, then the
// glyph, label, and wrapper are removed; the residual must equal Hono's bytes.
const KIT = { kit: true };
const hash = " svelte-q1w2e3";
const glyphHtml = (attrs = "") =>
  `<svg class="state-glyph${hash}" viewBox="0 0 16 16" aria-hidden="true" focusable="false"${attrs}>` +
  '<!--[--><circle cx="8" cy="8" r="8" fill="currentColor"></circle><!--]--></svg>';
const labelHtml = `<span class="event-state${hash}">Sign-up record</span>`;
function card(o = {}) {
  const { key = "raid", title = "Raid night", href = `/e/${key}`, date = "02 Jan 2026" } = o;
  const info = `<h2><a href="${href}">${title}</a></h2><p><time datetime="2026-01-02T03:04:05.000Z">${date}</time> <span>UTC</span></p>${o.extra ?? ""}`;
  const wrapped = o.ember
    ? `<div class="event-title${hash}">${glyphHtml()}${info.slice(0, info.indexOf("</h2>") + 5)}${labelHtml}</div>${info.slice(info.indexOf("</h2>") + 5)}`
    : info;
  return `<li class="schedule-row" data-testid="event-card" data-event-key="${key}"><span class="schedule-date" aria-hidden="true"><span>Jan</span><strong>02</strong></span><div class="schedule-info">${wrapped}</div><span class="schedule-attendance">${o.going ?? "3 going"}</span></li>`;
}
const section = (cards, pager = "", q = "") =>
  `<html><section data-island="past-events" data-testid="past-events"><form><input name="q" value="${q}"></form><ul>${cards.join("")}</ul>${pager}</section></html>`;
const pagerHtml = (next = "/events/past?page=2") =>
  `<nav data-testid="pager"><a rel="next" href="${next}">Next</a></nav>`;
const hono = (cards, ...rest) => contractSectionOf(section(cards, ...rest), "past-events");
const kitOf = (cards, ...rest) => contractSectionOf(section(cards, ...rest), "past-events", KIT);
const keys = ["a", "b", "c"];
const both = (build) => ({ h: keys.map((k) => build(k)), e: keys.map((k) => build(k, true)) });

test("Ember delta: legacy and Ember Kit sections equal Hono; Hono side stays strict", () => {
  const { h, e } = both((key, ember) => card({ key, ember }));
  assert.equal(kitOf(h), hono(h), "legacy Kit passes unchanged");
  assert.equal(kitOf(e), hono(h), "Ember Kit equals Hono after delta removal");
  assert.notEqual(hono(e), hono(h), "no stripping without the kit side flag");
  assert.equal(kitOf([], pagerHtml()), hono([], pagerHtml()), "empty list and pager");
  const search = (ember) => [
    card({
      ember,
      title: "<span><mark>Raid</mark> night</span>",
      extra:
        '<p data-testid="event-card-host">Hosted by Mara</p><p class="archive-passage"><mark>raid</mark> text</p>',
    }),
  ];
  assert.equal(kitOf(search(true), pagerHtml(), "raid"), hono(search(false), pagerHtml(), "raid"));
  const odd = (ember) => [
    card({ ember, title: 'Sign-up record &lt;img onerror=x&gt; class="event-title" &amp;' }),
  ];
  assert.equal(kitOf(odd(true)), hono(odd(false)), "escaped text that mimics the delta is content");
});

test("Ember delta: feature assertions require glyph and label on every card", () => {
  const { h, e } = both((key, ember) => card({ key, ember }));
  assertEmberArchive(section(e));
  for (const bad of [section(h), section([]), section([e[0], h[1]])]) {
    assert.throws(() => assertEmberArchive(bad));
  }
  assert.throws(() => assertEmberArchive(section([e[0].replace(glyphHtml(), "")])));
  assert.throws(() => assertEmberArchive(section([e[0].replace(labelHtml, "")])));
  const secondInfo = e[1].match(/<div class="schedule-info">[\s\S]*?<\/h2>[^]*?<\/div>/)[0];
  const redistributed = [
    e[0].replace(
      '<span class="schedule-attendance">',
      `${secondInfo}<span class="schedule-attendance">`,
    ),
    h[1],
  ];
  assert.throws(() => assertEmberArchive(section(redistributed)), /multiple wrappers on one card/);
  assert.throws(() => kitOf(redistributed), /multiple wrappers on one card/);
});

test("Ember delta: glyph, label, wrapper, and topology mutations fail closed", () => {
  const ember = card({ ember: true });
  const mutants = {
    "marker-spliced glyph tag": ember.replace("<svg ", "<sv<!--[-->g "),
    "marker spliced into wrapper": ember.replace(glyphHtml(), "<!---->" + glyphHtml()),
    "glyph duplicate attribute": ember.replace(
      'class="state-glyph',
      'class="evil" class="state-glyph',
    ),
    "glyph trailing duplicate": ember.replace(
      'focusable="false"',
      'focusable="false" focusable="true"',
    ),
    "glyph entity attribute": ember.replace(
      glyphHtml(),
      glyphHtml().replace('aria-hidden="true"', 'aria-hidden="&#116;rue"'),
    ),
    "glyph entity geometry": ember.replace('cx="8"', 'cx="&#56;"'),
    "circle duplicate attribute": ember.replace('r="8"', 'r="8" r="9"'),
    "glyph implied end tag": ember.replace("</circle>", ""),
    "label entity text": ember.replace("Sign-up", "Sign&#45;up"),
    "label entity class": ember.replace('class="event-state', 'class="event&#45;state'),
    "label duplicate attribute": ember.replace(
      'class="event-state',
      'class="x" class="event-state',
    ),
    "label implied end tag": ember.replace("Sign-up record</span>", "Sign-up record"),
    "wrapper duplicate attribute": ember.replace(
      '<div class="event-title',
      '<div class="x" class="event-title',
    ),
    "wrapper entity class": ember.replace('class="event-title', 'class="event&#45;title'),
    "heading attribute": ember.replace("<h2>", '<h2 class="x">'),
    "glyph radius": ember.replace('r="8"', 'r="7"'),
    "glyph fill": ember.replace('fill="currentColor"', 'fill="none"'),
    "glyph viewBox": ember.replace("0 0 16 16", "0 0 24 24"),
    "glyph not decorative": ember.replace(
      glyphHtml(),
      glyphHtml().replace('aria-hidden="true"', 'aria-hidden="false"'),
    ),
    "glyph aria missing": ember.replace(
      glyphHtml(),
      glyphHtml().replace(' aria-hidden="true"', ""),
    ),
    "glyph focusable": ember.replace('focusable="false"', 'focusable="true"'),
    "glyph class": ember.replace("state-glyph", "state-glyph live"),
    "glyph namespace": ember.replace("<svg ", '<svg xmlns="http://www.w3.org/1999/xhtml" '),
    "glyph prefix tag": ember.replace("<svg ", "<svg:svg ").replace("</svg>", "</svg:svg>"),
    "glyph attribute order": ember.replace(
      'viewBox="0 0 16 16" aria-hidden="true"',
      'aria-hidden="true" viewBox="0 0 16 16"',
    ),
    "glyph event": ember.replace("<svg ", '<svg onload="x" '),
    "circle event": ember.replace("<circle ", '<circle onclick="x" '),
    "circle extra": ember.replace("</circle>", "</circle><circle></circle>"),
    "glyph extra node": ember.replace("</svg>", "<script></script></svg>"),
    "glyph nested svg": ember.replace("</svg>", "<svg></svg></svg>"),
    "glyph missing": ember.replace(glyphHtml(), ""),
    "glyph duplicate": ember.replace(glyphHtml(), glyphHtml() + glyphHtml()),
    "glyph moved after heading": ember
      .replace(glyphHtml(), "")
      .replace(labelHtml, glyphHtml() + labelHtml),
    "glyph outside wrapper": ember.replace(
      '<div class="event-title',
      glyphHtml() + '<div class="event-title',
    ),
    "label text": ember.replace("Sign-up record", "Sign up record"),
    "label tag": ember.replace(labelHtml, labelHtml.replace(/span/g, "b")),
    "label class": ember.replace("event-state", "event-state hot"),
    "label event": ember.replace(
      '<span class="event-state',
      '<span onclick="x" class="event-state',
    ),
    "label missing": ember.replace(labelHtml, ""),
    "label duplicate": ember.replace(labelHtml, labelHtml + labelHtml),
    "label moved before heading": ember.replace(labelHtml, "").replace("<h2>", labelHtml + "<h2>"),
    "label moved outside wrapper": ember.replace(labelHtml + "</div>", "</div>" + labelHtml),
    "wrapper event": ember.replace(
      '<div class="event-title',
      '<div onmouseover="x" class="event-title',
    ),
    "wrapper attribute": ember.replace('<div class="event-title', '<div id="t" class="event-title'),
    "wrapper tag": ember
      .replace('<div class="event-title', '<section class="event-title')
      .replace(labelHtml + "</div>", labelHtml + "</section>"),
    "wrapper extra tag": ember.replace(labelHtml, labelHtml + "<img src=x>"),
    "wrapper hostile iframe": ember.replace(labelHtml, labelHtml + "<iframe></iframe>"),
    "nested wrapper": ember.replace(
      '<div class="event-title',
      '<div class="event-title"><div class="event-title',
    ),
    "nested host": ember.replace(
      labelHtml,
      labelHtml + '<p data-testid="event-card-host">Hosted by X</p>',
    ),
    "wrapper not first": ember.replace(
      '<div class="schedule-info">',
      '<div class="schedule-info"><p>x</p>',
    ),
    "unterminated heading": ember.replace("</h2>", ""),
    "wrapper unterminated": ember.replace(labelHtml + "</div>", labelHtml),
  };
  for (const [name, bad] of Object.entries(mutants)) {
    assert.notEqual(bad, ember, `${name}: mutation applied`);
    assert.throws(() => kitOf([bad]), /Ember archive delta/, name);
  }
  assert.throws(() => kitOf([card({ ember: true }), card({ key: "b" })]), /1 of 2 cards/);
  assert.throws(() => contractSectionOf("<p>x</p>", "past-events", KIT), /is missing/);
});

test("Ember delta: residual differences from Hono stay visible", () => {
  const base = (o) => [card({ key: "a", ember: true, ...o }), card({ key: "b", ember: true })];
  const expected = hono([card({ key: "a" }), card({ key: "b" })], pagerHtml(), "x");
  assert.equal(kitOf(base(), pagerHtml(), "x"), expected);
  const differs = {
    link: kitOf(base({ href: "/e/other" }), pagerHtml(), "x"),
    key: kitOf(
      [card({ key: "z", ember: true, href: "/e/a" }), card({ key: "b", ember: true })],
      pagerHtml(),
      "x",
    ),
    title: kitOf(base({ title: "Raid  night" }), pagerHtml(), "x"),
    date: kitOf(base({ date: "03 Jan 2026" }), pagerHtml(), "x"),
    datetime: kitOf(
      base().map((row) => row.replace('datetime="2026-01-02', 'datetime="2026-01-03')),
      pagerHtml(),
      "x",
    ),
    host: kitOf(
      base({ extra: '<p data-testid="event-card-host">Hosted by Mara</p>' }),
      pagerHtml(),
      "x",
    ),
    location: kitOf(base({ extra: "<p>Location: Online</p>" }), pagerHtml(), "x"),
    game: kitOf(base({ extra: "<p>Game: Chess</p>" }), pagerHtml(), "x"),
    escaping: kitOf(base({ title: "Raid &lt;night&gt;" }), pagerHtml(), "x"),
    attendance: kitOf(base({ going: "4 going" }), pagerHtml(), "x"),
    "injected tag": kitOf(base({ title: "<img src=x onerror=y>" }), pagerHtml(), "x"),
    "extra node": kitOf(base({ extra: "<p>more</p>" }), pagerHtml(), "x"),
    query: kitOf(base(), pagerHtml(), "y"),
    page: kitOf(base(), pagerHtml("/events/past?page=3"), "x"),
    "pager missing": kitOf(base(), "", "x"),
    order: kitOf(base().reverse(), pagerHtml(), "x"),
    "row dropped": kitOf(base().slice(0, 1), pagerHtml(), "x"),
  };
  for (const [name, got] of Object.entries(differs)) assert.notEqual(got, expected, name);
});

test("Ember delta: every consumer applies it to the Kit side only, in agreement", async () => {
  const consumers = {
    "ci/kit-parity-gates.mjs": /sectionOf\(kitHtml, route\.compareSection, \{ kit: true \}\)/,
    "e2e/kit-parity/parity.spec.ts":
      /sectionOf\(bodies\.get\("kit"\)!, "past-events", \{ kit: true \}\)/,
  };
  for (const [file, pattern] of Object.entries(consumers)) {
    assert.match(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), pattern, file);
  }
  assert.equal([...e2eSource.matchAll(/normalize\(kitSectionOf\(kitHtml\)\)/g)].length, 2);
  assert.doesNotMatch(e2eSource, /normalize\(sectionOf\(kitHtml\)\)/);
  const path = join(scratchDir, "e2e-kit-section.mjs");
  const delta = pathToFileURL(new URL("./kit-archive-delta.mjs", import.meta.url).pathname).href;
  writeFileSync(
    path,
    `import { stripEmberDelta } from ${JSON.stringify(delta)};\n` +
      `${extractBlock(e2eSource, "const sectionOf = (html) => {")}\n` +
      `${extractBlock(e2eSource, "const kitSectionOf = (html) => {")}\nexport { kitSectionOf };\n`,
  );
  const { kitSectionOf } = await import(pathToFileURL(path).href);
  const { h, e } = both((key, ember) => card({ key, ember }));
  for (const [cards, bad] of [[h], [e], [[e[0], h[1]], true]]) {
    const html = section(cards, pagerHtml());
    if (bad) {
      assert.throws(() => kitSectionOf(html), /Ember archive delta/);
      assert.throws(() => contractSectionOf(html, "past-events", KIT), /Ember archive delta/);
    } else {
      assert.equal(e2eNormalize(kitSectionOf(html)), contractSectionOf(html, "past-events", KIT));
    }
  }
});
