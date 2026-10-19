import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
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
  assert.throws(() => e2eSectionOf(doc), /Archive section is missing/);
});
