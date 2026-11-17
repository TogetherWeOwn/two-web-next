import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchRouteEvidenceProducer } from "./route-evidence-jobs.mjs";

const jobs = Array.from({ length: 101 }, (_, index) => ({
  id: index + 1,
  name: index === 100 ? "synthetic producer" : `other ${index}`,
}));

function pages(first = jobs.slice(0, 100), second = jobs.slice(100), count = 101) {
  const requests = [];
  return {
    requests,
    request: async (path) => {
      requests.push(path);
      return { total_count: count, jobs: requests.length === 1 ? first : second };
    },
  };
}

test("collects all attempt pages before selecting the unique producer", async () => {
  const api = pages();
  assert.equal(
    (await fetchRouteEvidenceProducer(api.request, 12, 3, "synthetic producer")).id,
    101,
  );
  assert.deepEqual(api.requests, [
    "/actions/runs/12/attempts/3/jobs?per_page=100&page=1",
    "/actions/runs/12/attempts/3/jobs?per_page=100&page=2",
  ]);
});

test("refuses incomplete, inconsistent, or ambiguous pages", async () => {
  const incomplete = pages(jobs.slice(0, 99));
  await assert.rejects(fetchRouteEvidenceProducer(incomplete.request, 12, 3, "synthetic producer"));
  const duplicate = pages(jobs.slice(0, 100), [{ id: 1, name: "synthetic producer" }]);
  await assert.rejects(fetchRouteEvidenceProducer(duplicate.request, 12, 3, "synthetic producer"));
  const ambiguous = pages([{ ...jobs[0], name: "synthetic producer" }, ...jobs.slice(1, 100)]);
  await assert.rejects(fetchRouteEvidenceProducer(ambiguous.request, 12, 3, "synthetic producer"));
  let calls = 0;
  await assert.rejects(
    fetchRouteEvidenceProducer(
      async () => ({
        total_count: ++calls === 1 ? 101 : 102,
        jobs: calls === 1 ? jobs.slice(0, 100) : jobs.slice(100),
      }),
      12,
      3,
      "synthetic producer",
    ),
  );
});
