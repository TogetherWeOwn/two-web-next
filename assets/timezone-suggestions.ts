// Suggestions assist manual entry; they never define the validator's allowlist.
// Bound both work and DOM size, even with a broken/polyfilled Intl provider.
// Validating every zone is too much main-thread work at page load, so only a
// first slice is offered immediately; the rest completes on first focus,
// before the suggestion list can be opened.
export function suggestTimezones(input: HTMLInputElement | null): void {
  try {
    const list = input?.list;
    if (!input || !list?.options || list.options.length) return;
    let zones: string[];
    let total = 0;
    let index = 0;
    const seen = new Set<string>();
    const step = (all?: boolean) => {
      try {
        zones ??= Intl.supportedValuesOf("timeZone");
        total ||= zones.length > 512 ? 512 : zones.length;
      } catch {
        // Missing/throwing Intl leaves manual entry alone.
        return;
      }
      const end = !all && index + 32 < total ? index + 32 : total;
      for (; index < end; index++) {
        // Per-zone validation can throw on a broken provider; skip just it.
        try {
          const zone = zones[index];
          if (!zone || seen.has(zone)) continue;
          new Intl.DateTimeFormat("en", { timeZone: zone });
          seen.add(zone);
          list.appendChild(new Option(zone));
        } catch {
          // Skip just this zone; the rest of the list still populates.
        }
      }
    };
    step();
    input.addEventListener("focus", () => step(true), { once: true });
  } catch {
    // A throwing list getter or listener must not stop the host island from wiring.
  }
}
