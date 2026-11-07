import { dateStamp } from "./date-stamp";

export function faqLastReviewed(raw: string | undefined): { iso: string; label: string } | null {
  return dateStamp(raw, "Invalid community.faq_last_reviewed — hiding /faq stamp");
}
