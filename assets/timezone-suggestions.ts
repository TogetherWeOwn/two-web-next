// Suggestions assist manual entry; they never define the validator's allowlist.
// Bound both work and DOM size, even with a broken/polyfilled Intl provider.
// Validating every zone is too much main-thread work for one task at page
// load, so population runs in small slices and completes on first focus.
export function suggestTimezones(input: HTMLInputElement | null): void {
  const list = input?.list;
  if (!list?.options || list.options.length) return;
  let zones: string[];
  let total = 0;
  let index = 0;
  const seen = new Set<string>();
  function step(all?: boolean) {
    // Per-zone validation can throw on a broken provider; the catch below
    // skips just that entry and keeps going.
    try {
      zones ??= Intl.supportedValuesOf("timeZone");
      total ||= zones.length > 512 ? 512 : zones.length;
      const end = !all && index + 32 < total ? index + 32 : total;
      for (; index < end; index++) {
        const zone = zones[index];
        new Intl.DateTimeFormat("en", { timeZone: zone });
        if (!zone || seen.has(zone)) continue;
        seen.add(zone);
        list.appendChild(new Option(zone));
      }
      if (index < total) setTimeout(step, 0);
    } catch {
      // Missing/throwing Intl leaves manual entry alone. An unformattable
      // entry from a broken provider only skips itself: retry past it.
      if (index < total) {
        index++;
        setTimeout(step, 0);
      }
    }
  }
  step();
  input.addEventListener("focus", () => step(true), { once: true });
}
