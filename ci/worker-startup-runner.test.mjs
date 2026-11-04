import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  cpuLimits,
  parseCpuList,
  parseQuota,
  RUNNER_IMAGE,
  runnerIdentity,
} from "./worker-startup-runner.mjs";

const MOUNT = "30 25 0:27 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup2 rw\n";
const ROOT = "/sys/fs/cgroup";

// Build a readFile that serves a map and throws ENOENT for anything missing.
function reader(files) {
  return (file) => {
    if (!Object.hasOwn(files, file)) {
      throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
    }
    return files[file];
  };
}
// levels: [{ path, enabled, available, cpuMax, cpuset }] root -> leaf. undefined omits a file.
function fixture(group, levels, extra = {}) {
  const files = {
    "/proc/self/cgroup": `0::${group}\n`,
    "/proc/self/mountinfo": MOUNT,
    "/proc/self/status": "Name:\tnode\nCpus_allowed_list:\t0-3\n",
    ...extra,
  };
  for (const l of levels) {
    const dir = l.path === "/" ? ROOT : ROOT + l.path;
    files[`${dir}/cgroup.subtree_control`] = l.enabled ?? "cpu cpuset\n";
    files[`${dir}/cgroup.controllers`] = l.available ?? "cpu cpuset\n";
    if (l.cpuMax !== undefined) files[`${dir}/cpu.max`] = l.cpuMax;
    if (l.cpuset !== undefined) files[`${dir}/cpuset.cpus.effective`] = l.cpuset;
  }
  return files;
}
const lvl = (path, cpuMax, cpuset = "0-3\n", more = {}) => ({
  path,
  cpuMax,
  cpuset: cpuset === null ? undefined : cpuset,
  ...more,
});
const run = (files) => cpuLimits(reader(files));
const invalid = /Invalid or unavailable startup runner provenance/;

describe("parsers", () => {
  test("parseCpuList accepts ordered ranges and rejects malformed input", () => {
    assert.deepEqual(parseCpuList("0-2,5\n"), [0, 1, 2, 5]);
    for (const bad of ["", "3-1", "2,1", "1,1", "a", "0-70000", "0,,1", "0-1-2"])
      assert.throws(() => parseCpuList(bad), invalid, bad);
    assert.throws(() => parseCpuList("0".repeat(5000)), invalid);
  });
  test("parseQuota parses max and bounded values", () => {
    assert.deepEqual(parseQuota("max 100000\n"), { quotaUs: null, periodUs: 100000 });
    assert.deepEqual(parseQuota("200000 100000"), { quotaUs: 200000, periodUs: 100000 });
    for (const bad of [
      "",
      "max",
      "0 100000",
      "100000 0",
      "500 100000",
      "100000 999",
      "100000 2000000",
      "-1 100000",
      "1e5 100000",
    ])
      assert.throws(() => parseQuota(bad), invalid, bad);
  });
});

describe("cpuLimits hierarchy", () => {
  const rootLevel = lvl("/", undefined);
  test("limited leaf, throttled quota below affinity", () => {
    const r = run(
      fixture("/a/b", [rootLevel, lvl("/a", "max 100000\n"), lvl("/a/b", "150000 100000\n")]),
    );
    assert.equal(r.version, 2);
    assert.deepEqual(
      r.hierarchy.map((h) => h.path),
      ["/", "/a", "/a/b"],
    );
    assert.equal(r.quotaState, "limited");
    assert.equal(r.quotaCores, 1.5);
    assert.equal(r.affinity, "0-3");
    assert.equal(r.effectiveCpuCount, 1.5);
    assert.deepEqual(r.hierarchy[2].quota, { quotaUs: 150000, periodUs: 100000 });
  });
  test("tighter inherited ancestor wins over a looser leaf", () => {
    const r = run(
      fixture("/a/b", [rootLevel, lvl("/a", "100000 100000\n"), lvl("/a/b", "400000 100000\n")]),
    );
    assert.equal(r.quotaCores, 1);
    assert.equal(r.effectiveCpuCount, 1);
  });
  test("tighter leaf wins over a looser ancestor", () => {
    const r = run(
      fixture("/a/b", [rootLevel, lvl("/a", "300000 100000\n"), lvl("/a/b", "50000 100000\n")]),
    );
    assert.equal(r.quotaCores, 0.5);
  });
  test("explicit max everywhere is verified-unlimited and bounded by affinity", () => {
    const r = run(fixture("/a", [rootLevel, lvl("/a", "max 100000\n")]));
    assert.equal(r.quotaState, "verified-unlimited");
    assert.equal(r.quotaCores, null);
    assert.equal(r.effectiveCpuCount, 4);
  });
  test("quota above affinity does not raise the effective count", () => {
    const r = run(fixture("/a", [rootLevel, lvl("/a", "800000 100000\n")]));
    assert.equal(r.effectiveCpuCount, 4);
  });
  test("root membership is a single-level hierarchy", () => {
    const r = run(fixture("/", [rootLevel]));
    assert.equal(r.hierarchy.length, 1);
    assert.equal(r.quotaState, "verified-unlimited");
  });
  test("missing cpu.max is accepted when the parent cpu controller is disabled", () => {
    const files = fixture("/a", [{ ...rootLevel, enabled: "cpuset\n" }, lvl("/a", undefined)]);
    const r = run(files);
    assert.equal(r.quotaState, "verified-unlimited");
    assert.equal(r.hierarchy[1].quota, null);
  });
  test("missing cpu.max is rejected when the parent cpu controller is enabled", () => {
    assert.throws(() => run(fixture("/a", [rootLevel, lvl("/a", undefined)])), invalid);
  });
  test("malformed cpu.max is rejected", () => {
    for (const bad of ["garbage\n", "max\n", "0 100000\n", ""])
      assert.throws(
        () => run(fixture("/a", [rootLevel, lvl("/a", bad)])),
        invalid,
        JSON.stringify(bad),
      );
  });
  test("missing cpuset at the root or under an enabled parent is rejected", () => {
    assert.throws(() => run(fixture("/", [lvl("/", undefined, null)])), invalid);
    assert.throws(() => run(fixture("/a", [rootLevel, lvl("/a", "max 100000\n", null)])), invalid);
  });
  test("missing cpuset is accepted when the parent cpuset controller is disabled", () => {
    const r = run(
      fixture("/a", [{ ...rootLevel, enabled: "cpu\n" }, lvl("/a", "max 100000\n", null)]),
    );
    assert.equal(r.hierarchy[1].cpuset, null);
    assert.equal(r.hierarchy[0].cpuset, "0-3");
  });
  test("effective cpuset is the intersection of affinity and the narrowest cpuset", () => {
    const files = fixture("/a", [rootLevel, lvl("/a", "max 100000\n", "1-2\n")], {
      "/proc/self/status": "Cpus_allowed_list:\t1-2\n",
    });
    const r = run(files);
    assert.equal(r.affinity, "1-2");
    assert.equal(r.effectiveCpuCount, 2);
  });
  test("affinity outside the cgroup cpuset is rejected", () => {
    const files = fixture("/a", [rootLevel, lvl("/a", "max 100000\n", "1-2\n")]);
    assert.throws(() => run(files), invalid);
  });
  test("a child cpuset that widens its parent is rejected", () => {
    assert.throws(
      () => run(fixture("/a", [lvl("/", undefined, "0-1\n"), lvl("/a", "max 100000\n", "0-3\n")])),
      invalid,
    );
  });
  test("affinity row must appear exactly once and parse", () => {
    const lv = [rootLevel, lvl("/a", "max 100000\n")];
    for (const status of [
      "Name:\tx\n",
      "Cpus_allowed_list:\t0\nCpus_allowed_list:\t1\n",
      "Cpus_allowed_list:\tx\n",
    ])
      assert.throws(() => run(fixture("/a", lv, { "/proc/self/status": status })), invalid, status);
  });
});

describe("cpuLimits membership, mount, depth and bounds", () => {
  const lv = [lvl("/", undefined), lvl("/a", "max 100000\n")];
  test("rejects cgroup v1 or hybrid membership", () => {
    for (const m of ["1:cpu:/a\n0::/a\n", "12:cpu:/a\n", "0::a\n", "0::/a b\n", "0::/a/../b\n"])
      assert.throws(() => run(fixture("/a", lv, { "/proc/self/cgroup": m })), invalid, m);
  });
  test("rejects overlong membership", () => {
    assert.throws(
      () => run(fixture("/a", lv, { "/proc/self/cgroup": `0::/${"a/".repeat(2100)}\n` })),
      invalid,
    );
  });
  test("rejects zero or multiple cgroup2 mounts", () => {
    const base = fixture("/a", lv);
    assert.throws(
      () => run({ ...base, "/proc/self/mountinfo": "1 2 0:1 / / rw - ext4 /dev/x rw\n" }),
      invalid,
    );
    assert.throws(() => run({ ...base, "/proc/self/mountinfo": MOUNT + MOUNT }), invalid);
  });
  test("rejects a subtree mount and a non-standard mount point", () => {
    const base = fixture("/a", lv);
    assert.throws(
      () =>
        run({
          ...base,
          "/proc/self/mountinfo": "30 25 0:27 /a /sys/fs/cgroup rw - cgroup2 cgroup2 rw\n",
        }),
      invalid,
    );
    assert.throws(
      () =>
        run({ ...base, "/proc/self/mountinfo": "30 25 0:27 / /mnt/cg rw - cgroup2 cgroup2 rw\n" }),
      invalid,
    );
  });
  test("rejects hierarchies deeper than 64 levels", () => {
    const parts = Array.from({ length: 70 }, (_, i) => `d${i}`);
    const levels = [lvl("/", undefined)];
    for (let i = 1; i <= parts.length; i++)
      levels.push(lvl("/" + parts.slice(0, i).join("/"), "max 100000\n"));
    assert.throws(() => run(fixture("/" + parts.join("/"), levels)), invalid);
  });
  test("accepts a deep but bounded hierarchy", () => {
    const parts = Array.from({ length: 10 }, (_, i) => `d${i}`);
    const levels = [lvl("/", undefined)];
    for (let i = 1; i <= parts.length; i++)
      levels.push(lvl("/" + parts.slice(0, i).join("/"), "max 100000\n"));
    assert.equal(run(fixture("/" + parts.join("/"), levels)).hierarchy.length, 11);
  });
  test("rejects malformed or oversized controller files", () => {
    const base = fixture("/a", lv);
    assert.throws(
      () => run({ ...base, [`${ROOT}/a/cgroup.subtree_control`]: "cpu; rm\n" }),
      invalid,
    );
    assert.throws(
      () => run({ ...base, [`${ROOT}/cgroup.controllers`]: "cpu ".repeat(2000) }),
      invalid,
    );
  });
  test("a missing controller file is a hard error, not unlimited", () => {
    const base = fixture("/a", lv);
    delete base[`${ROOT}/a/cgroup.subtree_control`];
    assert.throws(
      () => run(base),
      (e) => e.code === "ENOENT",
    );
  });
  test("non-ENOENT read errors on optional files propagate", () => {
    const base = fixture("/a", lv);
    const read = (f) => {
      if (f.endsWith("/a/cpu.max")) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return reader(base)(f);
    };
    assert.throws(() => cpuLimits(read), /denied/);
  });
});

describe("runnerIdentity", () => {
  const OS = 'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\nVERSION_CODENAME=bookworm\n';
  const good = () => ({
    ...fixture("/a", [lvl("/", undefined), lvl("/a", "200000 100000\n")]),
    "/etc/os-release": OS,
  });
  const env = { STARTUP_RUNNER_IMAGE: RUNNER_IMAGE };

  test("returns identity with limits for the pinned image", () => {
    const id = runnerIdentity({ readFile: reader(good()), env });
    assert.equal(id.image, RUNNER_IMAGE);
    assert.equal(id.kind, "local/container");
    assert.match(id.osReleaseSha256, /^[0-9a-f]{64}$/);
    assert.equal(id.limits.quotaCores, 2);
    assert.equal(
      runnerIdentity({ readFile: reader(good()), env: { ...env, GITHUB_ACTIONS: "true" } }).kind,
      "github-actions/check",
    );
  });
  test("rejects a missing or wrong runner image", () => {
    const readFile = reader(good());
    assert.throws(() => runnerIdentity({ readFile, env: {} }), invalid);
    assert.throws(
      () => runnerIdentity({ readFile, env: { STARTUP_RUNNER_IMAGE: "node:24-bookworm" } }),
      invalid,
    );
    assert.throws(
      () =>
        runnerIdentity({
          readFile,
          env: { STARTUP_RUNNER_IMAGE: RUNNER_IMAGE.slice(0, -1) + "0" },
        }),
      invalid,
    );
  });
  test("rejects an os-release mismatch or unreadable file", () => {
    for (const bad of [
      "ID=ubuntu\nVERSION_CODENAME=jammy\n",
      "ID=debian\nVERSION_CODENAME=trixie\n",
      "ID=debian\n",
      "x".repeat(5000),
    ])
      assert.throws(
        () => runnerIdentity({ readFile: reader({ ...good(), "/etc/os-release": bad }), env }),
        invalid,
      );
    const missing = good();
    delete missing["/etc/os-release"];
    assert.throws(
      () => runnerIdentity({ readFile: reader(missing), env }),
      (e) => e.code === "ENOENT",
    );
  });
});
