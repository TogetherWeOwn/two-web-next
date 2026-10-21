#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ZERO = "00000000-0000-0000-0000-000000000000";

function readJson(root, path) {
  let text;
  try {
    text = readFileSync(resolve(root, path), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`missing snapshot chain file: ${path}`);
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`unparseable snapshot chain file: ${path}`);
  }
}

export function checkSnapshotChain(root) {
  const journal = readJson(root, "drizzle/meta/_journal.json");
  if (!Array.isArray(journal?.entries) || journal.entries.length === 0) {
    throw new Error("snapshot chain: journal has no entries");
  }
  let previous = null;
  const seen = new Set();
  for (const [index, entry] of journal.entries.entries()) {
    const number = typeof entry?.tag === "string" ? entry.tag.split("_")[0] : "";
    if (!/^\d+$/.test(number)) {
      throw new Error(`snapshot chain: journal entry ${index} has a malformed tag`);
    }
    const path = `drizzle/meta/${number}_snapshot.json`;
    let snapshot;
    try {
      snapshot = readJson(root, path);
    } catch (error) {
      if (error.message.startsWith("missing snapshot chain file:")) {
        throw new Error(`missing snapshot for journal entry ${entry.tag}: ${path}`);
      }
      throw error;
    }
    if (typeof snapshot?.id !== "string" || typeof snapshot?.prevId !== "string") {
      throw new Error(`snapshot chain: ${path} has no string id/prevId`);
    }
    if (seen.has(snapshot.id)) throw new Error(`snapshot chain: duplicate snapshot id in ${path}`);
    seen.add(snapshot.id);
    if (index === 0) {
      if (snapshot.prevId !== ZERO) {
        throw new Error(`snapshot chain: genesis ${path} prevId is not the zero id`);
      }
    } else if (snapshot.prevId !== previous.id) {
      throw new Error(
        `dangling prevId in ${path}: want ${previous.id} from ${previous.path}, found ${snapshot.prevId}`,
      );
    }
    previous = { id: snapshot.id, path };
  }
  return { entries: journal.entries.length, snapshots: seen.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (process.argv.length !== 2) {
    console.error("snapshot-chain: usage: node ci/check-snapshot-chain.mjs");
    process.exitCode = 2;
  } else {
    try {
      const result = checkSnapshotChain(root);
      console.log(
        `snapshot-chain: ok (${result.entries} journal entries; ${result.snapshots} linked snapshots)`,
      );
    } catch (error) {
      console.error(`snapshot-chain: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
