// Stable-key incident sink, adapted from two-bot-next/scripts/incident_issue.py.
const marker = (key) => `<!-- incident-key: ${key} -->`;
async function openIssues(api, key) {
  const matches = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await api("GET", `/issues?state=open&labels=incident&per_page=100&page=${page}`);
    if (
      !Array.isArray(batch) ||
      batch.length > 100 ||
      batch.some(
        (issue) =>
          !Number.isSafeInteger(issue?.number) ||
          issue.number <= 0 ||
          (issue.body != null && typeof issue.body !== "string"),
      )
    ) {
      throw new Error("Malformed incident issue list");
    }
    matches.push(
      ...batch.filter((issue) => !issue.pull_request && (issue.body ?? "").includes(marker(key))),
    );
    if (batch.length < 100) return matches.sort((a, b) => a.number - b.number);
  }
  throw new Error("Incident issue search exceeded ten pages");
}

export async function syncIncident({ api, key, title, body, recovered = false }) {
  if (!/^[a-z0-9][a-z0-9:._-]{0,79}$/.test(key)) throw new Error("Invalid incident key");
  const issues = await openIssues(api, key);
  const comment = (number, message) =>
    api("POST", `/issues/${number}/comments`, {
      body: message.slice(0, 6000),
    });
  if (recovered) {
    for (const issue of issues) {
      await comment(issue.number, `Recovered.\n\n${body}`);
      await api("PATCH", `/issues/${issue.number}`, { state: "closed", state_reason: "completed" });
    }
    return;
  }
  if (issues.length) {
    await comment(issues[0].number, `Still failing.\n\n${body}`);
    return;
  }
  try {
    await api("GET", "/labels/incident");
  } catch (error) {
    if (error.status !== 404) throw error;
    try {
      await api("POST", "/labels", {
        name: "incident",
        color: "b60205",
        description: "Unattended release or staging failure",
      });
    } catch (conflict) {
      if (conflict.status !== 422) throw conflict;
      await api("GET", "/labels/incident");
    }
  }
  const created = await api("POST", "/issues", {
    title: title.slice(0, 200),
    body: `${body.slice(0, 5800)}\n\n${marker(key)}\n`,
    labels: ["incident"],
  });
  if (!Number.isSafeInteger(created?.number) || created.number <= 0) {
    throw new Error("Incident creation returned no issue number");
  }
  // The normal workflows serialize their own runs. Replays can race them:
  // converge on the oldest keyed issue rather than leaving duplicate alerts.
  const first = (await openIssues(api, key))[0];
  if (first && first.number < created.number) {
    await comment(first.number, `Still failing.\n\n${body}`);
    await comment(created.number, `Duplicate of #${first.number}.`);
    await api("PATCH", `/issues/${created.number}`, {
      state: "closed",
      state_reason: "not_planned",
    });
  }
}
