import { constants } from "node:fs";
import { open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { validateCaptureFiles } from "./join-evidence-contract.mjs";

// Read only admitted regular files, without following an evidence-file symlink.
export async function readCaptureFiles(directory, profile = "baseline") {
  const entries = await readdir(directory, { withFileTypes: true });
  validateCaptureFiles(entries, profile);
  const files = new Map();
  for (const entry of entries) {
    const handle = await open(
      join(directory, entry.name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      const limit = entry.name === "test-report.tap" ? 1024 * 1024 : 32 * 1024 * 1024;
      if (!info.isFile() || info.size > limit)
        throw new Error(`invalid evidence file: ${entry.name}`);
      const bytes = Buffer.alloc(info.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
        if (bytesRead === 0) break;
        count += bytesRead;
      }
      if (count !== info.size) throw new Error(`evidence file changed: ${entry.name}`);
      files.set(entry.name, bytes.subarray(0, count));
    } finally {
      await handle.close();
    }
  }
  return { entries, files };
}
