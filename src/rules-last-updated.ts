import { dateStamp } from "./date-stamp";

export function rulesLastUpdated(raw: string | undefined): { iso: string; label: string } | null {
  return dateStamp(raw, "Invalid community.rules_last_updated — hiding /rules stamp");
}
