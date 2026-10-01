const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function rulesLastUpdated(raw: string | undefined): { iso: string; label: string } | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  const invalid = () => {
    console.warn("Invalid community.rules_last_updated — hiding /rules stamp");
    return null;
  };
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = m?.[1];
  const mon = m?.[2];
  const dayStr = m?.[3];
  if (!year || !mon || !dayStr) return invalid();
  const monthIndex = Number(mon) - 1;
  const month = MONTHS[monthIndex];
  const day = Number(dayStr);
  const yearNumber = Number(year);
  const leapYear = yearNumber % 4 === 0 && (yearNumber % 100 !== 0 || yearNumber % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maximumDay = monthLengths[monthIndex];
  if (month === undefined || maximumDay === undefined || day < 1 || day > maximumDay) return invalid();
  return { iso: `${year}-${mon}-${dayStr}`, label: `${day} ${month} ${year}` };
}
