import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const workflow = readFileSync(".github/workflows/ci-ref-auth-probe.yml", "utf8");
const scripts = [...workflow.matchAll(/^          script: \|\n((?: {12}[^\n]*\n|\n)+)/gm)].map(
  (match) => {
    const script = match[1];
    if (script === undefined) throw new Error("Missing workflow script capture");
    return script.replace(/^ {12}/gm, "");
  },
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const target = "a".repeat(40);
const main = "b".repeat(40);
const tagSha = "c".repeat(40);
const ref = "refs/tags/ci-probe/ref-auth/700-1-3";
const missing = () => Object.assign(new Error("not found"), { status: 404 });
const response = (data: unknown, status = 200) => ({ status, data });

function harness(env: Record<string, string> = {}) {
  const outputs: Record<string, string> = {};
  const summary = { addCodeBlock: vi.fn(), write: vi.fn(async () => {}) };
  summary.addCodeBlock.mockReturnValue(summary);
  const core = {
    info: vi.fn(),
    setOutput: vi.fn((key: string, value: string) => {
      outputs[key] = value;
    }),
    summary,
  };
  const context = {
    repo: { owner: "TogetherWeOwn", repo: "two-web-next" },
    eventName: "workflow_dispatch",
    runId: 700,
    sha: target,
    ref: "refs/heads/ci-probe/runhead",
  };
  const request = vi.fn();
  const process = {
    env: { TARGET_SHA: target, PROBE_ARM: "3", PROBE_RUN_ATTEMPT: "1", ...env },
  };
  const run = (index: number) =>
    new AsyncFunction("github", "context", "core", "process", scripts[index])(
      { request },
      context,
      core,
      process,
    );
  return { outputs, core, context, request, run };
}

function validProbe(h: ReturnType<typeof harness>) {
  h.request
    .mockResolvedValueOnce(response({ object: { sha: main } }))
    .mockResolvedValueOnce(response({ status: "ahead", merge_base_commit: { sha: target } }))
    .mockRejectedValueOnce(missing())
    .mockResolvedValueOnce(response({ sha: tagSha }, 201))
    .mockResolvedValueOnce(response({ ref, object: { sha: tagSha } }, 201));
}

function cleanup(env: Record<string, string> = {}) {
  return harness({ PROBE_REF: ref, PROBE_TAG_SHA: tagSha, ...env });
}

const owned = () => response({ ref, object: { sha: tagSha, type: "tag" } });

describe("isolated ref authorization probe", () => {
  it("is dispatch-only, least-privileged, serialized, bounded and checkout-free", () => {
    expect(scripts).toHaveLength(2);
    expect(workflow).toMatch(/^on:\n  workflow_dispatch:/m);
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    expect(workflow.match(/contents: write/g)).toHaveLength(1);
    expect(workflow).toContain("group: ci-ref-auth-probe\n  cancel-in-progress: false");
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toContain("if: ${{ always() }}");
    expect(workflow.match(/uses: actions\/github-script@[0-9a-f]{40}/g)).toHaveLength(2);
    expect(workflow).not.toMatch(
      /checkout@|secrets:|vars\.|environment:|workflow_call:|push:|schedule:/,
    );
    expect(workflow).not.toContain("/releases");
  });

  it("copies the annotated-tag then ref sequence only into a non-CalVer namespace", async () => {
    const h = harness();
    validProbe(h);
    await h.run(0);
    expect(h.outputs).toEqual({ ref, tag_sha: tagSha });
    expect(h.request.mock.calls.map(([route]) => route)).toEqual([
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "GET /repos/{owner}/{repo}/compare/{basehead}",
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      "POST /repos/{owner}/{repo}/git/tags",
      "POST /repos/{owner}/{repo}/git/refs",
    ]);
    expect(h.request.mock.calls[3]?.[1]).toMatchObject({ object: target, type: "commit" });
    expect(h.request.mock.calls[4]?.[1]).toMatchObject({ ref, sha: tagSha });
    expect(h.core.summary.addCodeBlock).toHaveBeenCalledWith(
      expect.stringContaining('"run_head"'),
      "json",
    );
  });

  it("passes fresh 15-second AbortSignals to the pinned fetch-based transport", async () => {
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    try {
      const h = harness();
      validProbe(h);
      await h.run(0);
      const clean = cleanup();
      clean.request
        .mockResolvedValueOnce(owned())
        .mockResolvedValueOnce(response(null, 204))
        .mockRejectedValueOnce(missing());
      await clean.run(1);
      const calls = [...h.request.mock.calls, ...clean.request.mock.calls];
      expect(timeout).toHaveBeenCalledTimes(calls.length);
      expect(timeout.mock.calls.every(([milliseconds]) => milliseconds === 15000)).toBe(true);
      const signals = calls.map(([, options]) => options.request.signal);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
      expect(new Set(signals).size).toBe(calls.length);
      expect(calls.every(([, options]) => options.request.timeout === undefined)).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each(["", "A".repeat(40), `${target}\n`, "main", "a".repeat(41)])(
    "rejects malformed target %j before any request",
    async (sha) => {
      const h = harness({ TARGET_SHA: sha });
      await expect(h.run(0)).rejects.toThrow("Invalid probe context");
      expect(h.request).not.toHaveBeenCalled();
    },
  );

  it("rejects fork context and an invalid arm before any request", async () => {
    const h = harness();
    h.context.repo.owner = "elsewhere";
    await expect(h.run(0)).rejects.toThrow("Invalid probe context");
    expect(h.request).not.toHaveBeenCalled();
    const invalid = harness({ PROBE_ARM: "4" });
    await expect(invalid.run(0)).rejects.toThrow("Invalid probe context");
    expect(invalid.request).not.toHaveBeenCalled();
  });

  it.each(["behind", "diverged", "unknown"])("refuses %s before writing", async (status) => {
    const h = harness();
    h.request
      .mockResolvedValueOnce(response({ object: { sha: main } }))
      .mockResolvedValueOnce(response({ status, merge_base_commit: { sha: target } }));
    await expect(h.run(0)).rejects.toThrow("not a main ancestor");
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.outputs).toEqual({});
  });

  it("refuses mismatched merge-base evidence and existing refs", async () => {
    const h = harness();
    h.request
      .mockResolvedValueOnce(response({ object: { sha: main } }))
      .mockResolvedValueOnce(response({ status: "ahead", merge_base_commit: { sha: main } }));
    await expect(h.run(0)).rejects.toThrow("not a main ancestor");
    const collision = harness();
    collision.request
      .mockResolvedValueOnce(response({ object: { sha: main } }))
      .mockResolvedValueOnce(response({ status: "identical", merge_base_commit: { sha: target } }))
      .mockResolvedValueOnce(owned());
    await expect(collision.run(0)).rejects.toThrow("not confirmed absent");
    expect(collision.outputs).toEqual({});
  });

  it("retains the exact 403 response body without logging request credentials or retrying", async () => {
    const h = harness();
    validProbe(h);
    h.request.mockReset();
    h.request
      .mockResolvedValueOnce(response({ object: { sha: main } }))
      .mockResolvedValueOnce(response({ status: "ahead", merge_base_commit: { sha: target } }))
      .mockRejectedValueOnce(missing())
      .mockResolvedValueOnce(response({ sha: tagSha }, 201))
      .mockRejectedValueOnce({
        status: 403,
        response: { data: { message: "Resource not accessible by integration", status: "403" } },
        request: { headers: { authorization: "must-not-log" } },
      });
    await expect(h.run(0)).rejects.toThrow("HTTP 403");
    expect(h.request).toHaveBeenCalledTimes(5);
    const logs = JSON.stringify(h.core.info.mock.calls);
    expect(logs).toContain("Resource not accessible by integration");
    expect(logs).not.toContain("must-not-log");
    expect(h.outputs).toEqual({ ref, tag_sha: tagSha });
  });

  it("deletes only the owned tag ref and independently verifies absence", async () => {
    const h = cleanup();
    h.request
      .mockResolvedValueOnce(owned())
      .mockResolvedValueOnce(response(null, 204))
      .mockRejectedValueOnce(missing());
    await h.run(1);
    expect(h.request.mock.calls[1]).toEqual([
      "DELETE /repos/{owner}/{repo}/git/refs/{ref}",
      expect.objectContaining({ ref: ref.slice(5) }),
    ]);
    expect(h.core.summary.addCodeBlock).toHaveBeenCalledWith(
      expect.stringContaining("confirmed absent"),
      "json",
    );
  });

  it("handles a refused create without deleting anything and still verifies absence", async () => {
    const h = cleanup();
    h.request.mockRejectedValue(missing());
    await h.run(1);
    expect(h.request).toHaveBeenCalledTimes(2);
    expect(h.request.mock.calls.every(([route]) => route.startsWith("GET "))).toBe(true);
  });

  it("does not delete an unowned or replaced ref", async () => {
    const h = cleanup();
    h.request.mockResolvedValueOnce(response({ ref, object: { sha: main, type: "tag" } }));
    await expect(h.run(1)).rejects.toThrow("not owned");
    expect(h.request).toHaveBeenCalledTimes(1);
    const invalid = cleanup({ PROBE_REF: "refs/tags/v2026.1107.0" });
    await expect(invalid.run(1)).rejects.toThrow("Invalid cleanup identity");
    expect(invalid.request).not.toHaveBeenCalled();
  });

  it("does not claim cleanup if verification fails or a ref remains", async () => {
    const h = cleanup();
    h.request.mockRejectedValueOnce({ status: 403 });
    await expect(h.run(1)).rejects.toThrow("Cannot verify");
    expect(h.core.summary.write).not.toHaveBeenCalled();
    const remains = cleanup();
    remains.request.mockResolvedValue(owned());
    await expect(remains.run(1)).rejects.toThrow("remains after cleanup");
    expect(remains.core.summary.write).not.toHaveBeenCalled();
  });

  it("does nothing when validation failed before creating a tag object", async () => {
    const h = harness();
    await h.run(1);
    expect(h.request).not.toHaveBeenCalled();
  });
});
