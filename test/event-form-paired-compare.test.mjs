import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { compare } from "../ci/event-form-paired-compare.mjs";

const revisions = {
  base: "81e6482f60468252ce1fdac78efa1f2d4f637e03",
  head: "945e1171cb92b7afe0ce7a12042c6fd97e0aebd9",
};
const harness = "002a22194eea319fd6f5a5d325e65aa778831e00";
const hashes =
  "19f67855f47321c1649e7f55a1076192bb3f532e9fd0ce48532efedbd341c49e  harness/e2e/admin-event-form.capture.ts\n90c77616b3d65b9feb8c034a2f4c3473583fdf6b9b0268cf51db39ca63e9889a  harness/playwright.event-form-capture.config.ts\n";
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
const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];
const names = [
  "multiline",
  "wire-at-limit",
  "wire-plus-one",
  "canonical-at-limit",
  "canonical-plus-one",
];
const descriptions = [
  "Doors open at 19:30.\nBring a deck.\n\nSnacks provided.",
  `First\nSecond\n${"x".repeat(985)}`,
  `First\nSecond\n${"x".repeat(986)}`,
  `First line\n${"x".repeat(989)}`,
  `First line\n${"x".repeat(990)}`,
];
const describe = (value) => ({
  value,
  codePoints: [...value].length,
  crlfBreaks: value.split("\r\n").length - 1,
  bareLf: value.replaceAll("\r\n", "").split("\n").length - 1,
  bareCr: value.replaceAll("\r\n", "").split("\r").length - 1,
  sha256: createHash("sha256").update(value).digest("hex"),
});
let root;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fixture() {
  root = await mkdtemp(path.join(tmpdir(), "paired-evidence-"));
  const manifests = {};
  for (const phase of ["base", "head"]) {
    const dir = path.join(root, `event-form-paired-${phase}-42`);
    await mkdir(dir);
    await writeFile(path.join(dir, "source-revision.txt"), revisions[phase]);
    await writeFile(path.join(dir, "harness-revision.txt"), harness);
    await writeFile(path.join(dir, "harness-files.sha256"), hashes);
    const entries = [];
    for (const [i, name] of names.entries())
      for (const [j, viewport] of viewports.entries()) {
        const key = `01KEVTFRMC${i}${j}`.padEnd(26, "0");
        const values = {
          description: descriptions[i],
          accessibility_notes: "Step-free entrance.\nQuiet room upstairs.",
          join_instructions: "1. Open the link.\n2. Ask for the table.\n3. Say hello.",
        };
        const typed = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, describe(v)]));
        const submitted = Object.fromEntries(
          Object.entries(values).map(([k, v]) => [k, describe(v.replaceAll("\n", "\r\n"))]),
        );
        const prefix = `${viewport.name}-${name}`;
        const screenshots = { filled: `${prefix}-1-filled.png`, after: `${prefix}-2-after.png` };
        // Only the header is relevant to this validator; this is not a decodable image.
        const png = Buffer.alloc(33);
        Buffer.from("89504e470d0a1a0a", "hex").copy(png);
        png.writeUInt32BE(13, 8);
        png.write("IHDR", 12);
        png.writeUInt32BE(viewport.width, 16);
        png.writeUInt32BE(viewport.height, 20);
        for (const file of Object.values(screenshots)) await writeFile(path.join(dir, file), png);
        entries.push({
          case: name,
          viewport,
          eventKey: key,
          route: `/admin/events/${key}`,
          seeded: { ...seed },
          controls: Object.fromEntries(Object.keys(values).map((k) => [k, {}])),
          typed,
          actualInputs: structuredClone(typed),
          post: { sent: true, status: phase === "base" ? 200 : 400, submitted },
          screenshots,
        });
      }
    manifests[phase] = {
      schema: "event-form-capture-e2e/1",
      phase,
      requestedSha: revisions[phase],
      observedHead: revisions[phase],
      headMatchesRequested: true,
      synthetic: true,
      viewports,
      cases: entries,
    };
    await writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifests[phase]));
  }
  return manifests;
}
async function save(phase, manifest) {
  await writeFile(
    path.join(root, `event-form-paired-${phase}-42`, "manifest.json"),
    JSON.stringify(manifest),
  );
}

test("inventories ten pairs while allowing different product outcomes", async () => {
  await fixture();
  const result = await compare(root, "42");
  expect(result.pairs).toHaveLength(10);
  expect(result.pairs[0].outcomes.base.status).not.toBe(result.pairs[0].outcomes.head.status);
  expect(JSON.parse(await readFile(path.join(root, "comparison.json"), "utf8"))).toEqual(result);
});

test.each([
  [
    "wrong seed in both captures",
    (m) => {
      m.cases[0].seeded.capacity = 9;
    },
  ],
  [
    "wrong event key",
    (m) => {
      m.cases[0].eventKey = "wrong";
    },
  ],
  [
    "inherited case name",
    (m) => {
      m.cases[0].case = "toString";
    },
  ],
  [
    "missing input",
    (m) => {
      delete m.cases[0].actualInputs.description;
    },
  ],
  [
    "wrong submitted text",
    (m) => {
      m.cases[0].post.submitted.description = describe("wrong");
    },
  ],
  [
    "unexplained absent post",
    (m) => {
      m.cases[0].post = { sent: false };
    },
  ],
  [
    "duplicate case",
    (m) => {
      m.cases[1] = structuredClone(m.cases[0]);
    },
  ],
])("rejects %s", async (_label, mutate) => {
  const manifests = await fixture();
  for (const phase of ["base", "head"]) {
    mutate(manifests[phase]);
    await save(phase, manifests[phase]);
  }
  await expect(compare(root, "42")).rejects.toThrow();
});

test("rejects a malformed image header", async () => {
  await fixture();
  await writeFile(
    path.join(root, "event-form-paired-base-42", "desktop-multiline-1-filled.png"),
    "not a PNG",
  );
  await expect(compare(root, "42")).rejects.toThrow(/invalid PNG/);
});
