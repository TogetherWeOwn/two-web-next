import assert from "node:assert/strict";
import { selection, verifyUndoVersion } from "./kit-cutover-deploy.mjs";

const section = "## Ember release input readback";
const fields = [
  "candidate_sha",
  "candidate_pin",
  "hono_sha",
  "hono_pin",
  "hono_serving_version",
  "hono_version_id",
  "hono_tag",
  "hono_annotation",
];
const maxPacketBytes = 512 * 1024;

function sectionStart(lines) {
  let start = -1;
  let openFence;
  let inComment = false;
  for (const [index, line] of lines.entries()) {
    if (!openFence && (inComment || /^ {0,3}<!--/.test(line))) {
      inComment = !line.includes("-->");
      continue;
    }
    const [, marker, info] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
    if (openFence) {
      if (marker?.startsWith(openFence) && /^[\t ]*$/.test(info)) openFence = undefined;
      continue;
    }
    if (marker && (marker[0] === "~" || !info.includes("`"))) openFence = marker;
    if (line === section) {
      assert.equal(start, -1);
      start = index;
    }
  }
  assert.ok(start >= 0);
  return start;
}

function readback(packet) {
  const lines = packet.split(/\r?\n/);
  const start = sectionStart(lines);
  assert.equal(lines[start + 1], "");
  assert.equal(lines[start + 2], "```text");
  const first = start + 3;
  assert.equal(lines[first + fields.length], "```");
  const [sha, pin, honoSha, honoPin, servingVersion, versionId, tag, annotation] = fields.map(
    (field, index) => {
      const prefix = `${field}=`;
      const line = lines[first + index];
      assert.ok(line.startsWith(prefix) && line.length > prefix.length);
      return line.slice(prefix.length);
    },
  );

  // Model the dispatch shape for selection's offline checks. The protected
  // workflow independently supplies and verifies its actual context.
  const selected = selection({
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    PRODUCTION_AUTO_PROMOTE_DISABLED: "true",
    CUTOVER_MODE: "ember",
    INPUT_SHA: sha,
    DEPLOY_SHA: sha,
    CUTOVER_PIN: pin,
    CUTOVER_UNDO_VERSION: servingVersion,
  });
  assert.equal(honoSha, selected.sourceSha);
  assert.equal(honoPin, pin);
  verifyUndoVersion(
    { id: versionId, annotations: { "workers/tag": tag, "workers/message": annotation } },
    selected,
  );
  return {
    mode: selected.mode,
    candidateSha: selected.sourceSha,
    qualificationPin: pin,
    honoUndoVersion: selected.undo,
    undoManifestSha256: selected.digest,
  };
}

async function main() {
  assert.equal(process.argv.length, 2);
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    assert.ok(size <= maxPacketBytes);
    chunks.push(chunk);
  }
  const packet = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  const result = readback(packet);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try {
  await main();
} catch {
  // Validator and parser errors can contain packet values.
  process.stderr.write(
    "Ember release readback failed. Check the evidence section, candidate pin and Hono undo binding.\n",
  );
  process.exitCode = 1;
}
