// The extra informative audit is not referenced by any category or assertion.
// onlyAudits is additive to the existing onlyCategories: ["performance"] filter.
import DocumentTiming from "./lighthouse-document-timing.mjs";

export default {
  extends: "lighthouse:default",
  settings: { onlyAudits: ["main-document-timing"] },
  audits: [DocumentTiming],
};
