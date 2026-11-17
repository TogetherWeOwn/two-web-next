// Event fields come from the runner's event file; livePull and run are fetched
// independently from GitHub. Neither report contents nor producer output is an
// authority for the source SHA. This check does not authenticate workflow code.
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

export function bindRouteEvidencePullRequest(context, event, run, livePull) {
  const refuse = () => {
    throw new Error("route evidence refused: inconsistent pull request binding");
  };
  const number = event?.number;
  const sourceSha = event?.pull_request?.head?.sha;
  if (
    !context ||
    context.eventName !== "pull_request" ||
    typeof context.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(context.repository) ||
    !Number.isSafeInteger(number) ||
    number < 1 ||
    context.ref !== `refs/pull/${number}/merge` ||
    !sha(context.sha) ||
    !sha(sourceSha) ||
    event.repository?.full_name !== context.repository ||
    event.pull_request?.number !== number ||
    event.pull_request?.base?.repo?.full_name !== context.repository ||
    event.pull_request?.base?.ref !== "main" ||
    run?.event !== "pull_request" ||
    run.repository?.full_name !== context.repository ||
    (run.head_sha !== context.sha && run.head_sha !== sourceSha) ||
    livePull?.number !== number ||
    livePull.state !== "open" ||
    livePull.base?.repo?.full_name !== context.repository ||
    livePull.base?.ref !== "main" ||
    livePull.head?.sha !== sourceSha
  )
    refuse();
  return { pullNumber: number, sourceSha, runHeadSha: run.head_sha };
}
