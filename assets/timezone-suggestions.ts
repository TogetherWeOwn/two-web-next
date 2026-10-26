// Suggestions assist manual entry; they never define the validator's allowlist.
// Bound both work and DOM size, even with a broken/polyfilled Intl provider.
export function suggestTimezones(input: HTMLInputElement | null): void {
  try {
    const list = input?.list;
    if (!list?.options || list.options.length) return;
    const zones = Intl.supportedValuesOf("timeZone");
    if (!Array.isArray(zones)) return;
    const seen = new Set<string>();
    for (const zone of zones.slice(0, 512)) {
      if (typeof zone !== "string" || !zone || zone.length > 64 || seen.has(zone)) continue;
      try {
        new Intl.DateTimeFormat("en", { timeZone: zone });
      } catch {
        continue;
      }
      seen.add(zone);
      const option = document.createElement("option");
      option.value = zone;
      list.appendChild(option);
    }
  } catch {
    // Missing/throwing Intl or native datalist support leaves manual entry alone.
    return;
  }
}
