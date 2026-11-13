// Compare capture inputs and inventory image pairs; product outcomes may differ.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const revisions = {
  base: "81e6482f60468252ce1fdac78efa1f2d4f637e03",
  head: "945e1171cb92b7afe0ce7a12042c6fd97e0aebd9",
};
const harness = "002a22194eea319fd6f5a5d325e65aa778831e00";
const harnessHashes = [
  "19f67855f47321c1649e7f55a1076192bb3f532e9fd0ce48532efedbd341c49e  harness/e2e/admin-event-form.capture.ts",
  "90c77616b3d65b9feb8c034a2f4c3473583fdf6b9b0268cf51db39ca63e9889a  harness/playwright.event-form-capture.config.ts",
];
const fields = ["description", "accessibility_notes", "join_instructions"];
const seed = {
  title: "E2E form capture night",
  game: "Synthetic Chess",
  description: "Seed description",
  accessibility_notes: "Seed access note",
  organizer_name: "Synthetic Organizer",
  join_url: "https://example.test/lobby",
  join_instructions: "Seed joining note",
  location: "Voice",
  timezone: "UTC",
  capacity: 8,
  status: "draft",
  starts_at: "2098-12-31T20:00:00.000Z",
  ends_at: "2098-12-31T22:00:00.000Z",
};
const multiline = {
  description: "Doors open at 19:30.\nBring a deck.\n\nSnacks provided.",
  accessibility_notes: "Step-free entrance.\nQuiet room upstairs.",
  join_instructions: "1. Open the link.\n2. Ask for the table.\n3. Say hello.",
};
const cases = {
  multiline,
  "wire-at-limit": { ...multiline, description: `First\nSecond\n${"x".repeat(985)}` },
  "wire-plus-one": { ...multiline, description: `First\nSecond\n${"x".repeat(986)}` },
  "canonical-at-limit": { ...multiline, description: `First line\n${"x".repeat(989)}` },
  "canonical-plus-one": { ...multiline, description: `First line\n${"x".repeat(990)}` },
};
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
const digest = (value) => createHash("sha256").update(value).digest("hex");
const describe = (value) => {
  const withoutCrlf = value.replaceAll("\r\n", "");
  const count = (s, needle) => s.split(needle).length - 1;
  return {
    value,
    codePoints: [...value].length,
    crlfBreaks: count(value, "\r\n"),
    bareLf: count(withoutCrlf, "\n"),
    bareCr: count(withoutCrlf, "\r"),
    sha256: digest(value),
  };
};

async function image(directory, name, width, minHeight) {
  assert.match(name, /^[a-z0-9-]+\.png$/);
  const bytes = await readFile(path.join(directory, name));
  assert.ok(
    bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
    `invalid PNG: ${name}`,
  );
  assert.equal(bytes.readUInt32BE(8), 13, `invalid IHDR length: ${name}`);
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR", `missing IHDR: ${name}`);
  assert.equal(bytes.readUInt32BE(16), width, `unexpected image width: ${name}`);
  assert.ok(bytes.readUInt32BE(20) >= minHeight, `unexpected image height: ${name}`);
  return { file: name, sha256: digest(bytes), width, height: bytes.readUInt32BE(20) };
}

export async function compare(root, runId) {
  assert.match(runId, /^[0-9]+$/, "run ID must be numeric");
  const captures = {};
  for (const phase of ["base", "head"]) {
    const dir = path.join(root, `event-form-paired-${phase}-${runId}`);
    const text = async (file) => (await readFile(path.join(dir, file), "utf8")).trim();
    assert.equal(await text("source-revision.txt"), revisions[phase]);
    assert.equal(await text("harness-revision.txt"), harness);
    assert.deepEqual((await text("harness-files.sha256")).split("\n"), harnessHashes);
    const manifest = JSON.parse(await text("manifest.json"));
    assert.equal(manifest.schema, "event-form-capture-e2e/1");
    assert.equal(manifest.phase, phase);
    assert.equal(manifest.requestedSha, revisions[phase]);
    assert.equal(manifest.observedHead, revisions[phase]);
    assert.equal(manifest.headMatchesRequested, true);
    assert.equal(manifest.synthetic, true);
    assert.deepEqual(manifest.viewports, viewports);
    assert.equal(manifest.cases.length, 10);
    const entries = new Map();
    for (const entry of manifest.cases) {
      assert.ok(Object.hasOwn(cases, entry.case), "unexpected case");
      const expected = cases[entry.case];
      const viewportIndex = viewports.findIndex((item) => item.name === entry.viewport?.name);
      assert.notEqual(viewportIndex, -1, "unexpected viewport");
      const viewport = viewports[viewportIndex];
      assert.deepEqual(entry.viewport, viewport);
      const key = `${viewport.name}-${entry.case}`;
      assert.ok(!entries.has(key), `duplicate case: ${key}`);
      const caseIndex = Object.keys(cases).indexOf(entry.case);
      const eventKey = `01KEVTFRMC${caseIndex}${viewportIndex}`.padEnd(26, "0");
      assert.equal(entry.eventKey, eventKey);
      assert.equal(entry.route, `/admin/events/${eventKey}`);
      assert.deepEqual(entry.seeded, seed, `unexpected seed: ${key}`);
      for (const field of fields) {
        assert.ok(entry.controls?.[field], `missing control: ${field}`);
        assert.deepEqual(entry.typed?.[field], describe(expected[field]));
        assert.deepEqual(entry.actualInputs?.[field], describe(expected[field]));
        if (entry.post?.sent === true)
          assert.deepEqual(
            entry.post.submitted?.[field],
            describe(expected[field].replaceAll("\n", "\r\n")),
          );
      }
      assert.equal(typeof entry.post?.sent, "boolean");
      if (entry.post.sent)
        assert.ok(
          Number.isInteger(entry.post.status) &&
            entry.post.status >= 100 &&
            entry.post.status <= 599,
        );
      else
        assert.ok(
          fields.some(
            (field) =>
              typeof entry.clientBlockedSubmit?.[field] === "string" &&
              entry.clientBlockedSubmit[field].length > 0,
          ),
        );
      const images = {};
      for (const [state, suffix] of [
        ["filled", "1-filled"],
        ["after", "2-after"],
      ]) {
        const filename = `${key}-${suffix}.png`;
        assert.equal(entry.screenshots?.[state], filename);
        images[state] = await image(dir, filename, viewport.width, viewport.height);
      }
      entries.set(key, { entry, images });
    }
    captures[phase] = entries;
  }
  const pairs = [];
  for (const viewport of viewports)
    for (const caseName of Object.keys(cases)) {
      const key = `${viewport.name}-${caseName}`;
      const base = captures.base.get(key);
      const head = captures.head.get(key);
      assert.ok(base && head, `missing case: ${key}`);
      assert.deepEqual(base.entry.seeded, head.entry.seeded, `fixture mismatch: ${key}`);
      assert.deepEqual(base.entry.actualInputs, head.entry.actualInputs, `input mismatch: ${key}`);
      pairs.push({
        key,
        base: base.images,
        head: head.images,
        outcomes: { base: base.entry.post, head: head.entry.post },
      });
    }
  const result = {
    schema: "event-form-paired-comparison/1",
    revisions,
    harness,
    pairs,
    note: "Image hashes inventory files; differing pixels and product outcomes require human review.",
  };
  await writeFile(path.join(root, "comparison.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await compare(process.argv[2], process.argv[3]);
}
