export const RECOVERY_MANIFEST = "manifest.json";
export const RECOVERY_REQUIRED_FILES = Object.freeze(["worker.js", "effective-config.json"]);
export const RECOVERY_MEMBER_LIMITS = Object.freeze({
  maxArchiveBytes: 64 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxEntries: 4097, // up to 4096 payload files plus the manifest
  maxManifestBytes: 1024 * 1024,
  maxRatio: 100,
});

const DOS_DEVICE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i;

export function validRecoveryZipPath(path) {
  if (!validRecoveryMemberPath(path)) return false;
  const parts = path.split("/");
  return parts.length <= 32 && !parts.some((part) => DOS_DEVICE.test(part));
}

export function validRecoveryMemberPath(path) {
  return (
    path === RECOVERY_MANIFEST ||
    (typeof path === "string" &&
      path.length <= 512 &&
      (RECOVERY_REQUIRED_FILES.includes(path) || path.startsWith("assets/")) &&
      path.split("/").every((part) => /^[a-zA-Z0-9._-]+$/.test(part) && !part.endsWith(".")))
  );
}

// Treat implicit directories as paths too, not just the listed file names.
export function recordRecoveryPath(paths, path) {
  let prefix = "";
  for (const part of path.split("/")) {
    prefix += prefix ? `/${part}` : part;
    const folded = prefix.toLowerCase();
    const previous = paths.get(folded);
    const kind = prefix === path ? "file" : "directory";
    if (previous && (previous.prefix !== prefix || previous.kind !== kind)) return false;
    paths.set(folded, { prefix, kind });
  }
  return true;
}
