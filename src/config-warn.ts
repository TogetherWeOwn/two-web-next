// Once-per-isolate warnings for invalid operator configuration.
//
// Four operator-controlled settings fall back silently on invalid input,
// which makes a one-character typo indistinguishable from "unset" in every
// log stream. Callers route those fallbacks through warnInvalidConfigOnce so
// the typo is loud exactly once per isolate: module state is per-isolate,
// so a restart warns again, while repeats within an isolate stay silent.
//
// The helper logs only the variable name and the offending value it is
// given. All four current callers pass non-secret settings; never pass
// secret material here (secret readiness names names without values in
// src/up-config.ts).
const warned = new Set<string>();

export function warnInvalidConfigOnce(variable: string, value: string): void {
  const key = `${variable}\0${value}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`Invalid ${variable} — using the default; fix the setting to silence this warning`, {
    variable,
    value,
  });
}
