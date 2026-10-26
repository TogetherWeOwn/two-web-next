// Literal expectations, independent of the production schedule URL/resolver helpers.
export const scheduleGameCatalog = [
  "Deep Rock Galactic",
  "Baldur's Gate 3",
  "D&D / Tabletop",
  '<img src=x onerror="window.gameLabelExecuted=true">',
];

export const scheduleGameCases = [
  { label: "Deep Rock Galactic", href: "/events?game=Deep+Rock+Galactic" },
  { label: "  dEeP rOcK gAlAcTiC  ", href: "/events?game=Deep+Rock+Galactic" },
  { label: "Baldur's Gate 3", href: "/events?game=Baldur%27s+Gate+3" },
  { label: "D&D / Tabletop", href: "/events?game=D%26D+%2F+Tabletop" },
  {
    label: '<img src=x onerror="window.gameLabelExecuted=true">',
    href: "/events?game=%3Cimg+src%3Dx+onerror%3D%22window.gameLabelExecuted%3Dtrue%22%3E",
  },
  { label: "Deep Rock", href: null },
  { label: "Unlisted game", href: null },
  { label: "javascript:alert(1)", href: null },
] as const;
