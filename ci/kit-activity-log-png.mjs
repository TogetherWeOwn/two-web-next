import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, inflateSync } from "node:zlib";

export const viewportPngs = {
  "populated-desktop.png": [1280, 800],
  "empty-desktop.png": [1280, 800],
  "populated-mobile.png": [390, 844],
  "empty-mobile.png": [390, 844],
  "keyboard-mobile.png": [390, 844],
};
const maxBytes = 2 * 1024 * 1024;
const signature = Buffer.from("89504e470d0a1a0a", "hex");

function valid(bytes, [width, height]) {
  if (!bytes.subarray(0, 8).equals(signature)) return false;
  let channels = 0;
  const idat = [];
  let srgb = false;
  for (let at = 8; at + 12 <= bytes.length; ) {
    const size = bytes.readUInt32BE(at);
    const end = at + 8 + size;
    if (end + 4 > bytes.length || bytes.readUInt32BE(end) !== crc32(bytes.subarray(at + 4, end)))
      return false;
    const type = bytes.toString("latin1", at + 4, at + 8);
    const body = bytes.subarray(at + 8, end);
    if (at === 8) {
      if (type !== "IHDR" || size !== 13 || body[12] !== 0) return false;
      if (body.readUInt32BE(0) !== width || body.readUInt32BE(4) !== height) return false;
      const format = body.readUInt32BE(8);
      channels = format === 0x08020000 ? 3 : format === 0x08060000 ? 4 : 0;
      if (!channels) return false;
    } else if (type === "sRGB" && !srgb && !idat.length && size === 1 && body[0] <= 3) srgb = true;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND" && size === 0 && end + 4 === bytes.length && idat.length) {
      const stride = 1 + width * channels;
      const compressed = Buffer.concat(idat);
      const { buffer, engine } = inflateSync(compressed, {
        maxOutputLength: height * stride,
        info: true,
      });
      if (buffer.length !== height * stride || engine.bytesWritten !== compressed.length)
        return false;
      for (let row = 0; row < buffer.length; row += stride) if (buffer[row] > 4) return false;
      return true;
    } else return false;
    at = end + 4;
  }
  return false;
}

export function validatePngDirectory(dir) {
  const names = Object.keys(viewportPngs);
  if (
    !lstatSync(dir).isDirectory() ||
    JSON.stringify(readdirSync(dir).sort()) !== JSON.stringify([...names].sort())
  ) {
    throw new Error("incorrect viewport inventory");
  }
  return names.map((name) => {
    const file = join(dir, name);
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes)
      throw new Error(`invalid viewport file: ${name}`);
    const bytes = readFileSync(file);
    if (!valid(bytes, viewportPngs[name])) throw new Error(`invalid viewport PNG: ${name}`);
    return { name, sha256: createHash("sha256").update(bytes).digest("hex") };
  });
}
