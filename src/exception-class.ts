// Shared exception-class sanitizer for log lines. Log paths carry the
// exception CLASS, never its message, and the class name itself can be
// hostile (a class can define any `name`): de-newline and bound it so it
// cannot forge log lines or unbounded fingerprints, and degrade a
// non-string name to "unknown" instead of throwing inside a logging path.
// Import-free and strip-safe: src/roles.ts loads this from the strip-only
// bin/check-moderators.mjs CLI.

const MAX_EXCEPTION_CLASS_LENGTH = 100;

export function sanitizeExceptionClass(raw: unknown): string {
  const name = typeof raw === "string" ? raw : "unknown";
  return name.replace(/[\r\n]+/g, "_").slice(0, MAX_EXCEPTION_CLASS_LENGTH) || "unknown";
}
