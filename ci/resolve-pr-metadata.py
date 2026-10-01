#!/usr/bin/env python3
"""Bind one current PR API snapshot to the revision checked by PR lint.

Dispatches require an open PR whose base and source are this repository and
whose current head is GITHUB_SHA. PR events also allow forks, but bind their
source identity/head to the event and to the checked merge commit's immutable
GitHub record. PR base snapshots can lag or advance independently of that merge.
Convention rules and Actions output transport remain separate from this helper.
"""

import json
import os
import re
import subprocess
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def repository_name(value):
    require(isinstance(value, str) and
            re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", value),
            "Missing or malformed repository identity")
    return value.casefold()


def ref_repository(ref):
    require(isinstance(ref, dict) and isinstance(ref.get("repo"), dict),
            "Missing PR ref repository")
    return repository_name(ref["repo"].get("full_name"))


def requested_number(event_name, event, dispatch_number):
    if event_name == "workflow_dispatch":
        require(isinstance(dispatch_number, str) and
                re.fullmatch(r"[1-9][0-9]*", dispatch_number),
                "Dispatch PR number must be a positive canonical integer")
        require(event.get("inputs", {}).get("pr_number") == dispatch_number,
                "Dispatch PR number differs from the event input")
        return int(dispatch_number)
    require(event_name == "pull_request", "Unsupported PR lint event")
    number = event.get("number")
    require(type(number) is int and number > 0, "Missing event PR number")
    return number


def resolve_metadata(event_name, repository, workflow_sha, checked_sha, parents,
                     event, pull_request, dispatch_number="", merge_commit=None):
    """Pure binding validator: no API, git, file or output side effects."""
    if event_name == "push":
        return {"title": "", "body": "", "author": "", "event": "push"}
    number = requested_number(event_name, event, dispatch_number)
    repo = repository_name(repository)
    require(repository_name(event.get("repository", {}).get("full_name")) == repo,
            "Event repository differs from the workflow repository")
    require(isinstance(workflow_sha, str) and
            re.fullmatch(r"[0-9a-f]{40}", workflow_sha) and checked_sha == workflow_sha,
            "Checkout does not match the workflow SHA")
    require(isinstance(pull_request, dict), "Malformed PR API snapshot")
    require(type(pull_request.get("number")) is int and pull_request["number"] == number,
            "API PR number differs from the requested PR")
    require(pull_request.get("state") == "open", "PR is not open")
    head = pull_request.get("head")
    base = pull_request.get("base")
    require(ref_repository(base) == repo, "PR base repository differs from the workflow repository")
    source = ref_repository(head)
    require(isinstance(head.get("sha"), str) and re.fullmatch(r"[0-9a-f]{40}", head["sha"]),
            "Missing or malformed PR head SHA")
    if event_name == "workflow_dispatch":
        require(source == repo, "Dispatches do not accept fork PR metadata")
        require(head["sha"] == workflow_sha, "Dispatch SHA differs from the current PR head")
    else:
        snapshot = event.get("pull_request")
        require(isinstance(snapshot, dict) and type(snapshot.get("number")) is int and
                snapshot["number"] == number, "Event PR identity differs from the requested PR")
        require(ref_repository(snapshot.get("base")) == repo and
                ref_repository(snapshot.get("head")) == source,
                "Event PR repository identities differ from the current PR")
        require(snapshot["head"].get("sha") == head["sha"], "PR head moved since the event")
        # GITHUB_SHA pins the GitHub-generated merge, not a moving base ref.
        # Event/API base.sha and live merge_commit_sha can describe a different
        # merge after base advancement. Verify the exact immutable commit instead.
        if workflow_sha != head["sha"]:
            require(len(parents) == 2 and parents[1] == head["sha"] and
                    all(isinstance(parent, str) and re.fullmatch(r"[0-9a-f]{40}", parent)
                        for parent in parents),
                    "Checked revision is not the event's head or base/head merge")
            require(isinstance(merge_commit, dict) and merge_commit.get("sha") == workflow_sha,
                    "Merge API commit differs from the workflow SHA")
            api_parents = merge_commit.get("parents")
            require(isinstance(api_parents, list) and len(api_parents) == 2 and
                    all(isinstance(parent, dict) for parent in api_parents) and
                    [parent.get("sha") for parent in api_parents] == parents,
                    "Checked merge parents differ from the immutable GitHub commit")
    title = pull_request.get("title")
    body = pull_request.get("body")
    author = pull_request.get("user", {}).get("login")
    require(isinstance(title, str) and (body is None or isinstance(body, str)) and
            isinstance(author, str) and author, "Malformed PR convention metadata")
    return {"title": title, "body": body or "", "author": author, "event": "pull_request"}


def command(args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout.strip()


def main():
    event_name = os.environ["GITHUB_EVENT_NAME"]
    if event_name == "push":
        metadata = resolve_metadata(event_name, "", "", "", [], {}, {})
    else:
        with open(os.environ["GITHUB_EVENT_PATH"], encoding="utf-8") as source:
            event = json.load(source)
        repository = os.environ["GITHUB_REPOSITORY"]
        repository_name(repository)
        dispatch_number = os.environ.get("PR_NUMBER", "")
        number = requested_number(event_name, event, dispatch_number)
        checked_sha = command(["git", "rev-parse", "HEAD"])
        # cat-file preserves parent headers even in checkout's depth-1 clone;
        # log/show %P treats a shallow tip as a root and hides its parents.
        headers = command(["git", "cat-file", "-p", "HEAD"]).split("\n\n", 1)[0]
        parents = [line.removeprefix("parent ") for line in headers.splitlines()
                   if line.startswith("parent ")]
        # One REST snapshot includes identity, current state/head and metadata;
        # separate gh title/body/author requests could mix different revisions.
        pull_request = json.loads(command(["gh", "api", f"repos/{repository}/pulls/{number}"]))
        workflow_sha = os.environ["GITHUB_SHA"]
        require(re.fullmatch(r"[0-9a-f]{40}", workflow_sha) and checked_sha == workflow_sha,
                "Checkout does not match the workflow SHA")
        merge_commit = None
        if event_name == "pull_request" and workflow_sha != pull_request.get("head", {}).get("sha"):
            merge_commit = json.loads(command([
                "gh", "api", f"repos/{repository}/git/commits/{workflow_sha}"]))
        metadata = resolve_metadata(event_name, repository, workflow_sha, checked_sha, parents,
                                    event, pull_request, dispatch_number, merge_commit)
    print(json.dumps(metadata))


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError:
        sys.exit("PR binding failed: could not read checkout or PR API snapshot")
    except (ValueError, KeyError, TypeError, AttributeError, OSError) as error:
        sys.exit(f"PR binding failed: {error}")
