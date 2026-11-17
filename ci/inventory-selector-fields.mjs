// Compose already-recognized file-selector data only. This does not parse or
// certify config source, model title filters, or authorize inventory credit.
const fields = new Set(["testDir", "testMatch", "testIgnore", "projects"]);
const projectFields = new Set(["testDir", "testMatch", "testIgnore"]);

function copyValue(key, value) {
  if (key === "testDir" && typeof value === "string") return value;
  if ((key === "testMatch" || key === "testIgnore") && Array.isArray(value)) {
    if (Array.from(value).every((item) => typeof item === "string")) return [...value];
  }
  if (key === "projects" && Array.isArray(value)) {
    return Array.from(value, (project) => copyRecord(project, projectFields));
  }
  throw new TypeError(`Invalid selector field: ${key}`);
}

function copyRecord(record, allowed) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError("Invalid selector record");
  }
  const copy = {};
  for (const [key, value] of Object.entries(record)) {
    if (!allowed.has(key)) throw new TypeError(`Unsupported selector field: ${key}`);
    copy[key] = copyValue(key, value);
  }
  return copy;
}

// Each record represents one source-ordered property or a proven spread.
// Absence leaves earlier fields intact; arrays, including projects, replace.
export function composeSelectorFields(records) {
  const result = {};
  for (const record of records) Object.assign(result, copyRecord(record, fields));
  return result;
}
