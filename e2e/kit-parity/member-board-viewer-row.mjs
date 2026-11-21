// The fixture viewer ranks first with one Going sign-up. normalizeSection
// turns aria-current="true" into bare aria-current on both renderers.
export const SEEDED_VIEWER_CELLS = '<td>1</td><th scope="row">QA Member</th><td>1</td>';
export const KIT_LABELED_VIEWER_CELLS = '<td>1</td><th scope="row">QA Member (you)</th><td>1</td>';
export const SEEDED_VIEWER_ROW = `<tr aria-current>${SEEDED_VIEWER_CELLS}</tr>`;
export const KIT_VIEWER_ROW_NAME = /^QA Member(?: \(you\))?$/;

// Remove only the literal Kit suffix on this exact marked row. Leave a
// duplicate occurrence (or differences anywhere else) visible to equality.
export function normalizeKitViewerRow(table) {
  return table.replace(`<tr aria-current>${KIT_LABELED_VIEWER_CELLS}</tr>`, SEEDED_VIEWER_ROW);
}
