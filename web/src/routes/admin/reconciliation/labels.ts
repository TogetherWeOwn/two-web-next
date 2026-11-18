const resolutions = {
  confirmed: "Confirmed",
  not_applied: "Not applied",
  superseded: "Superseded",
};

export function resolutionLabel(value: string | null) {
  return value && Object.hasOwn(resolutions, value)
    ? resolutions[value as keyof typeof resolutions]
    : "—";
}
