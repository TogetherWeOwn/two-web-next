import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  collect,
  METRIC,
  runCommand,
  summarizeProfile,
  summary,
  validateBudget,
  validateEvidence,
  validateUpload,
} from "./check-worker-startup.mjs";

// Live means exists and is not a zombie: a killed grandchild may linger as state Z
// until a non-init container PID 1 reaps it.
function isLive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
// Provenance records the actual executable and full argv, not a reconstructed command.
function provenance(call) {
  return [call.command, ...call.args];
}
function assertCommands(commands, calls, outdir) {
  const [ser, ...cold] = calls;
  assert.deepEqual(commands.serialize, provenance(ser, outdir));
  assert.equal(commands.serialize.at(-1), join(outdir, "worker.bundle"));
  assert.equal(commands.workingDirectory, repoRoot);
  assert.deepEqual(commands.dotenv, {
    file: join(outdir, "empty.env"),
    sha256: sha256(Buffer.alloc(0)),
  });
  for (const call of calls)
    assert.equal(call.args[call.args.indexOf("--env-file") + 1], join(outdir, "empty.env"));
  assert.equal(commands.profile.length, 3);
  commands.profile.forEach((argv, i) => {
    assert.deepEqual(argv, provenance(cold[i], outdir));
    assert.equal(argv[argv.indexOf("--worker") + 1], join(outdir, "worker.bundle"));
    assert.equal(argv.at(-1), join(outdir, `cold-${i + 1}.cpuprofile`));
  });
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const clone = (value) => JSON.parse(JSON.stringify(value));
const tmp = mkdtempSync(join(tmpdir(), "worker-startup-test-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const BUDGET = {
  version: 1,
  metric: METRIC,
  runs: 3,
  warnMs: 400,
  failMs: 700,
  tools: { wrangler: "4.156.1", miniflare: "5.20261101.0-beta", workerd: "1.20261101.1" },
};
const frame = (id, functionName, children) => ({
  id,
  callFrame: { functionName, url: "", scriptId: "0", lineNumber: 0, columnNumber: 0 },
  ...(children ? { children } : {}),
});
const NODES = [
  frame(1, "(root)", [2, 3, 4, 5, 6]),
  frame(2, "(idle)"),
  frame(3, "(garbage collector)"),
  frame(4, "(program)"),
  frame(5, "handleRequest"),
  frame(6, "wrapper"),
];
// Sample ids: 2 idle, 3 gc, 4 program/wrapper, 5 request, 6 wrapper.
function profile(samples, { start = 1000 } = {}) {
  const timeDeltas = samples.map(([, us]) => us);
  const total = timeDeltas.reduce((a, b) => a + b, 0);
  return {
    nodes: clone(NODES),
    startTime: start,
    endTime: start + total,
    samples: samples.map(([id]) => id),
    timeDeltas,
  };
}
const work = (us) =>
  profile([
    [5, us],
    [2, 1000],
  ]);
const buf = (p) => Buffer.from(JSON.stringify(p));
function reversalProfile(count = 50, indices = [1], reversalUs = 2) {
  return profile(
    Array.from({ length: count }, (_, i) => [5, indices.includes(i) ? -reversalUs : 2000]),
  );
}

function multipart({ metadata, parts = { "index.js": "export default {}" } }) {
  const b = "----testboundary123";
  let out = "";
  const add = (name, value) => {
    out += `--${b}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  };
  if (metadata !== undefined)
    add("metadata", typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  for (const [name, value] of Object.entries(parts)) {
    out += `--${b}\r\nContent-Disposition: form-data; name="${name}"; filename="${name}"\r\nContent-Type: application/javascript+module\r\n\r\n${value}\r\n`;
  }
  return Buffer.from(`${out}--${b}--\r\n`);
}
const goodMeta = { main_module: "index.js", bindings: [{ type: "hyperdrive", name: "DB" }] };
const goodUpload = () => multipart({ metadata: goodMeta });

describe("validateBudget", () => {
  test("accepts the shipped budget", () => {
    const shipped = JSON.parse(
      readFileSync(fileURLToPath(new URL("./worker-startup-budget.json", import.meta.url)), "utf8"),
    );
    assert.equal(validateBudget(shipped), shipped);
    assert.doesNotThrow(() => validateBudget(clone(BUDGET)));
  });
  const bad = {
    "extra key": (b) => {
      b.extra = 1;
    },
    "missing key": (b) => {
      delete b.warnMs;
    },
    "wrong version": (b) => {
      b.version = 2;
    },
    "wrong metric": (b) => {
      b.metric = "other";
    },
    "wrong runs": (b) => {
      b.runs = 5;
    },
    "wrong warn": (b) => {
      b.warnMs = 500;
    },
    "wrong fail": (b) => {
      b.failMs = 900;
    },
    "missing tool": (b) => {
      delete b.tools.workerd;
    },
    "extra tool": (b) => {
      b.tools.other = "1.0.0";
    },
    "non-string tool": (b) => {
      b.tools.wrangler = 4;
    },
    "bad tool chars": (b) => {
      b.tools.wrangler = "4 1;rm";
    },
    "empty tool": (b) => {
      b.tools.wrangler = "";
    },
    "too long tool": (b) => {
      b.tools.wrangler = "a".repeat(65);
    },
  };
  for (const [name, mutate] of Object.entries(bad)) {
    test(`rejects ${name}`, () => {
      const b = clone(BUDGET);
      mutate(b);
      assert.throws(() => validateBudget(b), /Invalid local startup budget/);
    });
  }
  for (const v of [null, undefined, [], "x", 1])
    test(`rejects ${JSON.stringify(v)}`, () => assert.throws(() => validateBudget(v)));
});

describe("summarizeProfile", () => {
  test("converts microseconds to milliseconds and excludes only idle", () => {
    const p = profile([
      [2, 5000],
      [3, 20000],
      [4, 10000],
      [5, 30000],
      [6, 40000],
    ]);
    const s = summarizeProfile(p);
    assert.deepEqual(s, {
      [METRIC]: 100,
      sampledMs: 105,
      idleMs: 5,
      gcMs: 20,
      windowMs: 105,
      unsampledMs: 0,
      samples: 5,
      reversals: 0,
      maxReversalUs: 0,
    });
  });
  test("GC, program/wrapper and request frames all count as non-idle", () => {
    for (const id of [3, 4, 5, 6]) {
      assert.equal(
        summarizeProfile(
          profile([
            [id, 50000],
            [2, 1000],
          ]),
        )[METRIC],
        50,
      );
    }
  });
  test("preserves a valid unsampled tail as unsampledMs", () => {
    const p = profile([
      [5, 184281],
      [2, 0],
    ]);
    p.endTime = p.startTime + 199674;
    const s = summarizeProfile(p);
    assert.equal(s.windowMs, 199.674);
    assert.equal(s.sampledMs, 184.281);
    assert.equal(s.unsampledMs, 15.393);
    assert.equal(s[METRIC], 184.281);
  });
  test("rejects sampled time exceeding window by more than 1ms", () => {
    const p = work(50000);
    p.endTime -= 1001;
    assert.throws(() => summarizeProfile(p), {
      message: "Invalid CPU profile sample: timestamp outside profile window at sample 1",
    });
  });
  test("accepts the retained 86-sample profile shape with one -2 us reversal", () => {
    // Numeric timing and frame classes from the failing cold-1 profile in run 42385737608.
    const timeDeltas = [
      38336, 9772, 1064, 1066, 1063, 1063, 1070, 1073, 1057, 1062, 1069, 1065, 1062, 1063, 1088,
      1061, 1061, 1065, 1066, 1064, 1063, 1059, 1063, 1064, 1069, 1066, 1064, 1064, 1066, 1068,
      1064, 1063, 1065, 1072, 1058, 1063, 1063, 1061, 1065, 1064, 1065, 1065, 1065, 1067, 1062,
      1063, 1066, 1062, 1066, 1067, 1081, 1072, 1068, 1081, 1079, 1081, 1083, 1084, 1068, 1082,
      1064, 1069, 1066, 77, 984, 1060, 1066, 1064, -2, 30, 1025, 1061, 1071, 1062, 1066, 1064, 1074,
      1066, 1073, 119, 948, 1063, 1385, 1068, 1064, 1062,
    ];
    const p = profile(
      timeDeltas.map((delta, i) => [i === 0 ? 2 : [14, 50, 58, 65, 82].includes(i) ? 3 : 5, delta]),
      { start: 2601042521 },
    );
    p.endTime = 2601184460;
    assert.deepEqual(summarizeProfile(p), {
      [METRIC]: 95.414,
      sampledMs: 133.75,
      idleMs: 38.336,
      gcMs: 5.682,
      windowMs: 141.939,
      unsampledMs: 8.189,
      samples: 86,
      reversals: 1,
      maxReversalUs: 2,
    });
  });
  test("sorts a -2 us reversal before idle and GC attribution without mutating the profile", () => {
    const p = reversalProfile();
    p.samples[0] = 2;
    p.samples[1] = 3;
    p.endTime += 15393;
    const before = clone(p);
    assert.deepEqual(summarizeProfile(p), {
      [METRIC]: 97.998,
      sampledMs: 97.998,
      idleMs: 0,
      gcMs: 1.998,
      windowMs: 113.391,
      unsampledMs: 15.393,
      samples: 50,
      reversals: 1,
      maxReversalUs: 2,
    });
    assert.deepEqual(p, before);
  });
  test("stable timestamp ties charge the first original sample and keep the raw delta sum", () => {
    const p = reversalProfile(100, [1, 99]);
    p.samples[1] = 2;
    p.timeDeltas[2] = 0;
    p.samples[2] = 3;
    // The final reversal leaves the last raw timestamp below the sorted maximum.
    p.endTime += 2;
    const s = summarizeProfile(p);
    assert.equal(s.sampledMs, 193.996);
    assert.equal(s.idleMs, 1.998);
    assert.equal(s.gcMs, 0);
    assert.equal(s[METRIC], 191.998);
    assert.equal(s.unsampledMs, 0.002);
    assert.equal(s.reversals, 2);
    assert.equal(s.maxReversalUs, 2);
  });
  test("accepts a reversal of exactly 1000 us", () => {
    const s = summarizeProfile(reversalProfile(50, [1], 1000));
    assert.equal(s.reversals, 1);
    assert.equal(s.maxReversalUs, 1000);
    assert.equal(s.sampledMs, 97);
  });
  test("rejects a reversal over 1000 us with its sample index", () => {
    assert.throws(() => summarizeProfile(reversalProfile(50, [1], 1001)), {
      message: "Invalid CPU profile sample: reversal 1001 us exceeds 1000 us at sample 1",
    });
  });
  for (const [count, indices, allowed] of [
    [49, [1], 0],
    [100, [1, 3, 5], 2],
    [149, [1, 3, 5], 2],
    [200, [1, 3, 5, 7], 3],
    [100, Array.from({ length: 50 }, (_, i) => i * 2 + 1), 2],
  ]) {
    test(`rejects ${indices.length} reversals in ${count} samples (limit ${allowed})`, () => {
      assert.throws(() => summarizeProfile(reversalProfile(count, indices)), {
        message: `Invalid CPU profile sample: reversal count ${allowed + 1} exceeds ${allowed} at sample ${indices[allowed]}`,
      });
    });
  }
  test("accepts three reversals at the 150-sample boundary and reports the largest", () => {
    const p = reversalProfile(150, [1, 3, 5]);
    p.timeDeltas[3] = -10;
    const s = summarizeProfile(p);
    assert.equal(s.reversals, 3);
    assert.equal(s.maxReversalUs, 10);
    assert.equal(s.sampledMs, 293.986);
  });
  test("rejects timestamps below the window without clamping", () => {
    const p = reversalProfile();
    p.timeDeltas[0] = -2;
    assert.throws(() => summarizeProfile(p), {
      message: "Invalid CPU profile sample: timestamp outside profile window at sample 0",
    });
  });
  test("rejects timestamps above the window even within the old 1000 us tolerance", () => {
    const p = work(50000);
    p.endTime -= 1;
    assert.throws(() => summarizeProfile(p), {
      message: "Invalid CPU profile sample: timestamp outside profile window at sample 1",
    });
  });
  test("accepts timestamps on both inclusive window boundaries", () => {
    assert.equal(
      summarizeProfile(
        profile([
          [5, 0],
          [5, 1000],
        ]),
      ).sampledMs,
      1,
    );
  });
  test("rejects idle-only profile", () => {
    assert.throws(() => summarizeProfile(profile([[2, 5000]])), /Incomplete CPU profile timing/);
  });
  for (const [name, field, value, message] of [
    [
      "non-integer node id",
      "samples",
      1.5,
      "Invalid CPU profile sample: non-integer node id at sample 1 (1.5)",
    ],
    ["unknown node", "samples", 999, "Invalid CPU profile sample: unknown node 999 at sample 1"],
    [
      "non-finite timeDelta",
      "timeDeltas",
      Infinity,
      "Invalid CPU profile sample: non-finite timeDelta at sample 1 (Infinity)",
    ],
    [
      "excess reversal count",
      "timeDeltas",
      -5,
      "Invalid CPU profile sample: reversal count 1 exceeds 0 at sample 1",
    ],
  ]) {
    test(`names ${name} and the offending sample index`, () => {
      const p = work(50000);
      p[field][1] = value;
      assert.throws(() => summarizeProfile(p), { message });
    });
  }
  test("still rejects the NaN delta regression without rendering it as null", () => {
    const p = work(50000);
    p.timeDeltas[0] = NaN;
    assert.throws(() => summarizeProfile(p), {
      message: "Invalid CPU profile sample: non-finite timeDelta at sample 0 (NaN)",
    });
  });
  test("reports the first failing class in sample validation order", () => {
    const p = work(50000);
    p.samples[0] = "5";
    p.timeDeltas[0] = -5;
    assert.throws(() => summarizeProfile(p), {
      message: 'Invalid CPU profile sample: non-integer node id at sample 0 ("5")',
    });
    p.samples[0] = 999;
    assert.throws(() => summarizeProfile(p), {
      message: "Invalid CPU profile sample: unknown node 999 at sample 0",
    });
  });
  test("bounds JSON-rendered values and falls back for unstringifiable values", () => {
    const p = work(50000);
    for (const [value, rendered] of [
      ["x".repeat(100), JSON.stringify("x".repeat(100)).slice(0, 64)],
      [undefined, "undefined"],
      [1n, "1"],
    ]) {
      p.timeDeltas[0] = value;
      assert.throws(() => summarizeProfile(p), {
        message: `Invalid CPU profile sample: non-finite timeDelta at sample 0 (${rendered})`,
      });
    }
  });
  const bad = {
    "null profile": () => null,
    "no nodes": (p) => {
      p.nodes = [];
    },
    "nodes not array": (p) => {
      p.nodes = {};
    },
    "no samples": (p) => {
      p.samples = [];
      p.timeDeltas = [];
    },
    "sample/delta length mismatch": (p) => {
      p.timeDeltas.pop();
    },
    "deltas longer": (p) => {
      p.timeDeltas.push(1);
    },
    "NaN delta": (p) => {
      p.timeDeltas[0] = NaN;
    },
    "Infinity delta": (p) => {
      p.timeDeltas[0] = Infinity;
    },
    "negative delta": (p) => {
      p.timeDeltas[0] = -1;
    },
    "string delta": (p) => {
      p.timeDeltas[0] = "5";
    },
    "null delta": (p) => {
      p.timeDeltas[0] = null;
    },
    "nonfinite start": (p) => {
      p.startTime = Infinity;
    },
    "negative start": (p) => {
      p.startTime = -1;
    },
    "missing end": (p) => {
      delete p.endTime;
    },
    "end not after start": (p) => {
      p.endTime = p.startTime;
    },
    "window too large": (p) => {
      p.endTime = p.startTime + 15000001;
    },
    "unknown sample node": (p) => {
      p.samples[0] = 99;
    },
    "non-integer sample": (p) => {
      p.samples[0] = 1.5;
    },
    "duplicate node ids": (p) => {
      p.nodes.push(frame(2, "dup"));
    },
    "node id zero": (p) => {
      p.nodes[0].id = 0;
    },
    "node id float": (p) => {
      p.nodes[0].id = 1.5;
    },
    "node without callFrame": (p) => {
      delete p.nodes[1].callFrame;
    },
    "non-string functionName": (p) => {
      p.nodes[1].callFrame.functionName = 5;
    },
    "functionName too long": (p) => {
      p.nodes[1].callFrame.functionName = "x".repeat(4097);
    },
    "unknown child": (p) => {
      p.nodes[0].children = [2, 77];
    },
    "children not array": (p) => {
      p.nodes[0].children = "2";
    },
    "too many nodes": (p) => {
      p.nodes = Array.from({ length: 50001 }, (_, i) => frame(i + 1, "f"));
    },
    "too many samples": (p) => {
      p.samples = new Array(100001).fill(5);
      p.timeDeltas = new Array(100001).fill(1);
      p.endTime = p.startTime + 100001;
    },
  };
  for (const [name, mutate] of Object.entries(bad)) {
    test(`rejects ${name}`, () => {
      let p = work(50000);
      const r = mutate(p);
      if (name === "null profile") p = r;
      assert.throws(() => summarizeProfile(p));
    });
  }
  test("accepts exactly the node, sample and window limits", () => {
    const p = work(50000);
    p.nodes = Array.from({ length: 50000 }, (_, i) => frame(i + 1, i === 1 ? "(idle)" : "f"));
    p.samples = [5, 2];
    assert.equal(summarizeProfile(p)[METRIC], 50);
    const w = profile([
      [5, 15000000 - 1000],
      [2, 1000],
    ]);
    assert.equal(summarizeProfile(w).windowMs, 15000);
  });
});

// Build fully consistent evidence for three profile buffers.
const IDENTITY = {
  sha: "abc",
  uploadSha256: "u".repeat(64),
  tools: { versions: BUDGET.tools },
  runner: { kind: "local/linux-x64/node24" },
};
function makeEvidence(profileBufs, identity = IDENTITY) {
  const runs = profileBufs.map((b, i) => ({
    invocation: i + 1,
    completed: true,
    uploadSha256: identity.uploadSha256,
    profile: `cold-${i + 1}.cpuprofile`,
    profileSha256: sha256(b),
    measurement: summarizeProfile(JSON.parse(b.toString())),
  }));
  const maximumMs = Math.max(...runs.map((r) => r.measurement[METRIC]));
  const status = maximumMs >= 700 ? "fail" : maximumMs >= 400 ? "warn" : "pass";
  return {
    version: 1,
    metric: METRIC,
    authoritativeStartup: "unavailable",
    productionMargin: "unmet",
    identity: clone(identity),
    runs,
    maximumMs,
    status,
  };
}
const threeBufs = (a = 50000, b = 60000, c = 70000) => [buf(work(a)), buf(work(b)), buf(work(c))];

describe("validateEvidence verdict boundaries", () => {
  const cases = [
    [399999, "pass"],
    [400000, "warn"],
    [699999, "warn"],
    [700000, "fail"],
  ];
  for (const [us, verdict] of cases) {
    test(`max of three at ${us / 1000} ms is ${verdict}`, () => {
      // Maximum can be any of the three runs.
      for (const position of [0, 1, 2]) {
        const values = [10000, 20000, 30000];
        values[position] = us;
        const bufs = values.map((v) => buf(work(v)));
        const ev = makeEvidence(bufs);
        assert.equal(ev.status, verdict);
        assert.equal(ev.maximumMs, us / 1000);
        assert.equal(validateEvidence(ev, IDENTITY, bufs, BUDGET), verdict);
      }
    });
  }
  test("a low maximum run cannot hide behind low others and vice versa", () => {
    const bufs = threeBufs(399999, 399999, 400000);
    assert.equal(validateEvidence(makeEvidence(bufs), IDENTITY, bufs, BUDGET), "warn");
  });
});

describe("validateEvidence strictness", () => {
  const bufs = threeBufs();
  const check = (mutate, message) => {
    const ev = makeEvidence(bufs);
    let b = bufs;
    let expected = IDENTITY;
    const r = mutate(ev, {
      setBufs: (x) => {
        b = x;
      },
      setExpected: (x) => {
        expected = x;
      },
    });
    void r;
    assert.throws(() => validateEvidence(ev, expected, b, BUDGET), message);
  };
  test("accepts valid evidence", () => {
    assert.equal(validateEvidence(makeEvidence(bufs), IDENTITY, bufs, BUDGET), "pass");
  });
  test("validates the budget first", () => {
    assert.throws(
      () => validateEvidence(makeEvidence(bufs), IDENTITY, bufs, { ...BUDGET, failMs: 1 }),
      /Invalid local startup budget/,
    );
  });
  const identity = /Wrong build\/tool\/runner identity/;
  test("wrong build sha", () =>
    check((e) => {
      e.identity.sha = "zzz";
    }, identity));
  test("wrong tools", () =>
    check((e) => {
      e.identity.tools.versions.wrangler = "9.9.9";
    }, identity));
  test("wrong runner", () =>
    check((e) => {
      e.identity.runner.kind = "other";
    }, identity));
  test("wrong upload identity", () =>
    check((e) => {
      e.identity.uploadSha256 = "0".repeat(64);
    }, identity));
  test("extra identity field", () =>
    check((e) => {
      e.identity.extra = 1;
    }, identity));
  test("wrong version", () =>
    check((e) => {
      e.version = 2;
    }, identity));
  test("wrong metric", () =>
    check((e) => {
      e.metric = "x";
    }, identity));
  test("authoritative claimed", () =>
    check((e) => {
      e.authoritativeStartup = "available";
    }, identity));
  test("production margin claimed met", () =>
    check((e) => {
      e.productionMargin = "met";
    }, identity));
  test("extra top-level field", () =>
    check((e) => {
      e.extra = true;
    }, identity));
  test("missing top-level field", () =>
    check((e) => {
      delete e.status;
    }, identity));
  test("incomplete run count", () =>
    check((e) => {
      e.runs.pop();
    }, /Exactly three/));
  test("too many runs", () =>
    check((e) => {
      e.runs.push(clone(e.runs[0]));
    }, /Exactly three/));
  test("profile buffer count mismatch", () =>
    check((_, h) => h.setBufs(bufs.slice(0, 2)), /Exactly three/));
  test("runs not array", () =>
    check((e) => {
      e.runs = {};
    }, /Exactly three/));
  const run = /Incomplete or mismatched cold invocation/;
  test("failed run", () =>
    check((e) => {
      e.runs[1].completed = false;
    }, run));
  test("completed not boolean true", () =>
    check((e) => {
      e.runs[1].completed = "true";
    }, run));
  test("duplicate invocation", () =>
    check((e) => {
      e.runs[2].invocation = 2;
    }, run));
  test("out-of-order invocation", () =>
    check((e) => {
      [e.runs[0], e.runs[1]] = [e.runs[1], e.runs[0]];
    }, run));
  test("run upload hash mismatch", () =>
    check((e) => {
      e.runs[0].uploadSha256 = "1".repeat(64);
    }, run));
  test("wrong profile name", () =>
    check((e) => {
      e.runs[0].profile = "cold-9.cpuprofile";
    }, run));
  test("wrong profile hash", () =>
    check((e) => {
      e.runs[0].profileSha256 = "2".repeat(64);
    }, run));
  test("profile bytes differ from recorded hash", () =>
    check((_, h) => h.setBufs([buf(work(51000)), bufs[1], bufs[2]]), run));
  test("extra run field", () =>
    check((e) => {
      e.runs[0].extra = 1;
    }, run));
  test("altered measurement", () =>
    check((e) => {
      e.runs[0].measurement[METRIC] = 1;
    }, /Mismatched numeric profile evidence/));
  test("altered measurement sample count", () =>
    check((e) => {
      e.runs[0].measurement.samples += 1;
    }, /Mismatched numeric profile evidence/));
  for (const field of ["reversals", "maxReversalUs"]) {
    test(`altered measurement ${field}`, () =>
      check((e) => {
        e.runs[0].measurement[field] += 1;
      }, /Mismatched numeric profile evidence/));
    test(`missing measurement ${field}`, () =>
      check((e) => {
        delete e.runs[0].measurement[field];
      }, /Mismatched numeric profile evidence/));
  }
  test("altered maximum", () =>
    check((e) => {
      e.maximumMs = 1;
    }, /Incorrect local startup verdict/));
  test("altered verdict", () =>
    check((e) => {
      e.status = "fail";
    }, /Incorrect local startup verdict/));
  test("verdict pass where warn is required", () => {
    const b = threeBufs(10000, 20000, 450000);
    const ev = makeEvidence(b);
    ev.status = "pass";
    assert.throws(
      () => validateEvidence(ev, IDENTITY, b, BUDGET),
      /Incorrect local startup verdict/,
    );
  });
  test("malformed profile content inside valid hash", () => {
    const b = [Buffer.from("not json"), bufs[1], bufs[2]];
    const ev = makeEvidence(bufs);
    ev.runs[0].profileSha256 = sha256(b[0]);
    assert.throws(() => validateEvidence(ev, IDENTITY, b, BUDGET), SyntaxError);
  });
  test("nonfinite profile content is rejected", () => {
    const bad = work(50000);
    bad.timeDeltas[0] = -5;
    const b = [buf(bad), bufs[1], bufs[2]];
    const ev = makeEvidence(bufs);
    ev.runs[0].profileSha256 = sha256(b[0]);
    assert.throws(
      () => validateEvidence(ev, IDENTITY, b, BUDGET),
      /Invalid CPU profile sample: timestamp outside profile window at sample 0/,
    );
  });
  test("empty profile buffer", () => {
    const b = [Buffer.alloc(0), bufs[1], bufs[2]];
    const ev = makeEvidence(bufs);
    ev.runs[0].profileSha256 = sha256(b[0]);
    assert.throws(() => validateEvidence(ev, IDENTITY, b, BUDGET), /Invalid profile size/);
  });
});

describe("validateUpload", () => {
  test("accepts main blob plus hyperdrive binding", async () => {
    await validateUpload(goodUpload());
  });
  test("rejects missing hyperdrive guard", async () => {
    await assert.rejects(
      validateUpload(
        multipart({
          metadata: { main_module: "index.js", bindings: [{ type: "plain_text", name: "A" }] },
        }),
      ),
      /Unsupported startup upload shape/,
    );
  });
  test("rejects empty bindings", async () => {
    await assert.rejects(
      validateUpload(multipart({ metadata: { main_module: "index.js", bindings: [] } })),
      /Unsupported startup upload shape/,
    );
  });
  test("rejects missing bindings array", async () => {
    await assert.rejects(
      validateUpload(multipart({ metadata: { main_module: "index.js" } })),
      /Unsupported startup upload shape/,
    );
  });
  test("rejects missing main blob", async () => {
    await assert.rejects(
      validateUpload(multipart({ metadata: { ...goodMeta, main_module: "other.js" } })),
      /Unsupported startup upload shape/,
    );
  });
  test("rejects main part that is plain text rather than a file", async () => {
    const b = "----testboundary123";
    const body = Buffer.from(
      `--${b}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(goodMeta)}\r\n--${b}\r\nContent-Disposition: form-data; name="index.js"\r\n\r\ntext\r\n--${b}--\r\n`,
    );
    await assert.rejects(validateUpload(body), /Unsupported startup upload shape/);
  });
  test("rejects non-string main_module", async () => {
    await assert.rejects(
      validateUpload(multipart({ metadata: { ...goodMeta, main_module: 5 } })),
      /Unsupported startup upload shape/,
    );
  });
  test("rejects missing metadata part", async () => {
    await assert.rejects(validateUpload(multipart({})));
  });
  test("rejects malformed metadata JSON", async () => {
    await assert.rejects(validateUpload(multipart({ metadata: "{nope" })), SyntaxError);
  });
  test("rejects invalid boundary", async () => {
    await assert.rejects(
      validateUpload(Buffer.from("--bad boundary!\r\nfoo\r\n")),
      /Invalid serialized upload boundary/,
    );
    await assert.rejects(
      validateUpload(Buffer.from("garbage without newline")),
      /Invalid serialized upload boundary/,
    );
  });
});

describe("collect orchestration", () => {
  const cli = "/fake/wrangler.js";
  function harness({ upload = goodUpload(), profiles, failAt, mutateUploadAfter } = {}) {
    const outdir = mkdtempSync(join(tmp, "collect-"));
    const calls = [];
    const profs = profiles ?? [work(50000), work(60000), work(450000)];
    const run = async (command, args, options) => {
      calls.push({ command, args: [...args], options });
      const n = calls.length;
      if (failAt === n) throw new Error("child failed");
      const out = args[args.indexOf("--outfile") + 1];
      if (args.includes("deploy")) writeFileSync(out, upload);
      else {
        const p = profs[n - 2];
        writeFileSync(out, typeof p === "string" ? p : JSON.stringify(p));
        if (mutateUploadAfter === n) writeFileSync(join(outdir, "worker.bundle"), "tampered");
      }
    };
    return { outdir, calls, run };
  }
  test("serializes once, profiles three times independently from one upload, retains everything", async () => {
    const h = harness();
    const ev = await collect({
      outdir: h.outdir,
      budget: BUDGET,
      identity: { sha: "abc" },
      cli,
      run: h.run,
    });
    assert.equal(h.calls.length, 4);
    const [ser, ...cold] = h.calls;
    assert.equal(h.calls.filter((c) => c.args.includes("deploy")).length, 1);
    assert.equal(ser.command, process.execPath);
    assert.deepEqual(ser.args.slice(0, 7), [
      cli,
      "deploy",
      "--env-file",
      join(h.outdir, "empty.env"),
      "--config",
      "web/wrangler.staging.jsonc",
      "--dry-run",
    ]);
    assert.equal(ser.options.timeoutMs, 60000);
    const upload = join(h.outdir, "worker.bundle");
    assert.equal(ser.args.at(-1), upload);
    cold.forEach((c, i) => {
      assert.equal(c.command, process.execPath);
      assert.deepEqual(c.args, [
        cli,
        "check",
        "startup",
        "--env-file",
        join(h.outdir, "empty.env"),
        "--worker",
        upload,
        "--outfile",
        join(h.outdir, `cold-${i + 1}.cpuprofile`),
      ]);
    });
    assert.equal(new Set(cold.map((c) => c.args.at(-1))).size, 3);
    const uploadHash = sha256(readFileSync(upload));
    assert.equal(ev.identity.uploadSha256, uploadHash);
    assert.equal(ev.identity.sha, "abc");
    assert.equal(ev.runs.length, 3);
    ev.runs.forEach((r, i) => {
      assert.equal(r.invocation, i + 1);
      assert.equal(r.completed, true);
      assert.equal(r.uploadSha256, uploadHash);
      assert.equal(r.profileSha256, sha256(readFileSync(join(h.outdir, r.profile))));
    });
    assert.equal(ev.maximumMs, 450);
    assert.equal(ev.status, "warn");
    assert.equal(ev.authoritativeStartup, "unavailable");
    assert.equal(ev.productionMargin, "unmet");
    assertCommands(ev.identity.commands, h.calls, h.outdir);
    // Retained files re-validate against the evidence.
    const bufs = ev.runs.map((r) => readFileSync(join(h.outdir, r.profile)));
    assert.equal(validateEvidence(ev, ev.identity, bufs, BUDGET), "warn");
  });
  test("retains, validates and summarizes reversal diagnostics for each cold run", async () => {
    const h = harness({
      profiles: [reversalProfile(), reversalProfile(150, [1, 3, 5], 10), work(50000)],
    });
    const ev = await collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run });
    assert.equal(h.calls.length, 4);
    const bufs = ev.runs.map((r) => readFileSync(join(h.outdir, r.profile)));
    assert.equal(validateEvidence(ev, ev.identity, bufs, BUDGET), "pass");
    for (const [i, reversals, maxReversalUs] of [
      [0, 1, 2],
      [1, 3, 10],
      [2, 0, 0],
    ]) {
      const numeric = JSON.parse(readFileSync(join(h.outdir, `cold-${i + 1}.json`), "utf8"));
      assert.deepEqual(numeric, ev.runs[i]);
      assert.equal(numeric.measurement.reversals, reversals);
      assert.equal(numeric.measurement.maxReversalUs, maxReversalUs);
      assert(
        summary(ev).includes(`Cold ${i + 1}: ${reversals} reversals; largest ${maxReversalUs} us.`),
      );
    }
  });
  test("fail verdict at 700 ms", async () => {
    const h = harness({ profiles: [work(10000), work(700000), work(10000)] });
    const ev = await collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run });
    assert.equal(ev.status, "fail");
  });
  test("failed serialize stops before any profile", async () => {
    const h = harness({ failAt: 1 });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      /child failed/,
    );
    assert.equal(h.calls.length, 1);
  });
  for (const n of [2, 3, 4]) {
    test(`failed cold invocation ${n - 1} stops fail-closed without later runs`, async () => {
      const h = harness({ failAt: n });
      await assert.rejects(
        collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
        /child failed/,
      );
      assert.equal(h.calls.length, n);
    });
  }
  test("bad upload is rejected before profiling", async () => {
    const h = harness({
      upload: multipart({ metadata: { main_module: "index.js", bindings: [] } }),
    });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      /Unsupported startup upload shape/,
    );
    assert.equal(h.calls.length, 1);
  });
  test("empty upload is rejected", async () => {
    const h = harness({ upload: Buffer.alloc(0) });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      /Missing, empty or oversized/,
    );
  });
  test("invalid profile fails the collection", async () => {
    const bad = work(50000);
    bad.samples[0] = 999;
    const h = harness({ profiles: [bad, work(1), work(1)] });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      /Invalid CPU profile sample: unknown node 999 at sample 0/,
    );
    assert.equal(h.calls.length, 2);
  });
  test("malformed profile JSON fails the collection", async () => {
    const h = harness({ profiles: ["{not json", work(1), work(1)] });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      SyntaxError,
    );
  });
  test("missing profile output fails the collection", async () => {
    const h = harness();
    const run = async (c, a, o) => {
      if (a.includes("check")) {
        h.calls.push({ a });
        return;
      }
      return h.run(c, a, o);
    };
    await assert.rejects(collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run }));
  });
  test("failure after two successful profiles leaves an unavailable checkpoint with identity and completed runs", async () => {
    const h = harness({ failAt: 4 });
    const identity = {
      sha: "abc",
      sourceSha256: "s".repeat(64),
      tools: { versions: BUDGET.tools },
      runner: { kind: "local/linux-x64/node24" },
    };
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity, cli, run: h.run }),
      /child failed/,
    );
    assert.equal(h.calls.length, 4);
    const cp = JSON.parse(readFileSync(join(h.outdir, "checkpoint.json"), "utf8"));
    assert.equal(cp.version, 1);
    assert.equal(cp.metric, METRIC);
    assert.equal(cp.status, "unavailable");
    const uploadHash = sha256(readFileSync(join(h.outdir, "worker.bundle")));
    assert.equal(cp.identity.uploadSha256, uploadHash);
    assert.equal(cp.identity.sha, "abc");
    assert.equal(cp.identity.sourceSha256, identity.sourceSha256);
    assert.deepEqual(cp.identity.tools, identity.tools);
    assert.deepEqual(cp.identity.runner, identity.runner);
    assert.equal(cp.identity.commands.config, "web/wrangler.staging.jsonc");
    assertCommands(cp.identity.commands, h.calls.slice(0, 4), h.outdir);
    assert.equal(cp.runs.length, 2);
    cp.runs.forEach((r, i) => {
      assert.equal(r.invocation, i + 1);
      assert.equal(r.completed, true);
      assert.equal(r.uploadSha256, uploadHash);
      assert.equal(r.profile, `cold-${i + 1}.cpuprofile`);
      assert.equal(r.profileSha256, sha256(readFileSync(join(h.outdir, r.profile))));
      assert.equal(r.measurement[METRIC], [50, 60][i]);
    });
  });
  test("upload mutated between cold profiles is detected", async () => {
    const h = harness({ mutateUploadAfter: 2 });
    await assert.rejects(
      collect({ outdir: h.outdir, budget: BUDGET, identity: {}, cli, run: h.run }),
      /Upload changed between cold profiles/,
    );
    assert.equal(h.calls.length, 2);
  });
});

async function withSelftestEvidence(
  cwd,
  run,
  evidenceDir = process.env.WORKER_STARTUP_SELFTEST_EVIDENCE_DIR,
) {
  try {
    return await run();
  } catch (error) {
    try {
      if (evidenceDir) {
        mkdirSync(evidenceDir, { recursive: true });
        for (const file of readdirSync(cwd, { withFileTypes: true })) {
          if (
            file.isFile() &&
            (/^cold-.*\.(cpuprofile|json)$/.test(file.name) || file.name === "checkpoint.json")
          )
            copyFileSync(join(cwd, file.name), join(evidenceDir, file.name));
        }
      }
    } catch {
      // Retention is best-effort and must not replace the collection failure.
      process.stderr.write("Could not retain startup selftest evidence\n");
    }
    throw error;
  }
}

describe("selftest evidence retention", () => {
  test("copies only regular allowlisted files and rethrows the original error", async () => {
    const cwd = mkdtempSync(join(tmp, "retention-source-"));
    const evidenceDir = join(tmp, "retention-output", "nested");
    const allowed = ["cold-1.cpuprofile", "cold-2.cpuprofile", "cold-1.json", "checkpoint.json"];
    for (const file of [
      ...allowed,
      ".env",
      ".env.local",
      "empty.env",
      "owned-runtime",
      "worker.bundle",
      "control.bundle",
      "control.cpuprofile",
      "report.json",
      "cold-1.json.env",
    ])
      writeFileSync(join(cwd, file), `fixture ${file}`);
    mkdirSync(join(cwd, "cold-directory.json"));
    writeFileSync(join(cwd, "cold-directory.json", "nested.json"), "not evidence");
    symlinkSync(join(cwd, ".env"), join(cwd, "cold-link.json"));
    const original = new Error("original collection failure");
    await assert.rejects(
      withSelftestEvidence(
        cwd,
        async () => {
          throw original;
        },
        evidenceDir,
      ),
      (error) => error === original,
    );
    assert.deepEqual(readdirSync(evidenceDir).sort(), [...allowed].sort());
    for (const file of allowed)
      assert.deepEqual(readFileSync(join(evidenceDir, file)), readFileSync(join(cwd, file)));
  });
  test("does not create evidence on success", async () => {
    const evidenceDir = join(tmp, "retention-success");
    const result = {};
    assert.equal(await withSelftestEvidence(tmp, async () => result, evidenceDir), result);
    assert.equal(existsSync(evidenceDir), false);
  });
  test("retention disabled or failing still rethrows the original error", async () => {
    const original = new Error("original collection failure");
    const notDirectory = join(tmp, "retention-not-directory");
    writeFileSync(notDirectory, "fixture");
    for (const evidenceDir of ["", notDirectory]) {
      await assert.rejects(
        withSelftestEvidence(
          tmp,
          async () => {
            throw original;
          },
          evidenceDir,
        ),
        (error) => error === original,
      );
    }
  });
});

test("pinned real Wrangler loader cannot restore ignored dotenv runtime overrides", {
  timeout: 60000,
}, async () => {
  const cwd = mkdtempSync(join(tmp, "real-dotenv-"));
  const marker = join(cwd, "override-executed");
  const alternate = join(cwd, "owned-runtime");
  writeFileSync(alternate, `#!/bin/sh\nprintf executed > '${marker}'\nexit 1\n`, { mode: 0o700 });
  for (const file of [".env", ".env.local"]) {
    writeFileSync(join(cwd, file), `MINIFLARE_WORKERD_PATH=${alternate}\n`);
  }
  const cli = join(repoRoot, "node_modules/wrangler/bin/wrangler.js");
  const upload = join(cwd, "control.bundle");
  const loaderUpload = multipart({
    metadata: goodMeta,
    parts: {
      "index.js":
        "let value = 0; for (let i = 0; i < 10000000; i++) value += Math.sqrt(i); export default { fetch() { return new Response(String(value)); } };",
    },
  });
  writeFileSync(upload, loaderUpload);
  // Positive control: this is the pinned real CLI's global dotenv middleware,
  // not a mocked parser. The old sanitized environment alone is insufficient.
  await assert.rejects(
    runCommand(
      process.execPath,
      [cli, "check", "startup", "--worker", upload, "--outfile", join(cwd, "control.cpuprofile")],
      { cwd },
    ),
  );
  assert.equal(existsSync(marker), true, "control must execute the owned override");
  rmSync(marker);
  const calls = [];
  const evidence = await withSelftestEvidence(cwd, () =>
    collect({
      outdir: cwd,
      budget: BUDGET,
      identity: {},
      cli,
      run: async (command, args, options) => {
        calls.push({ command, args });
        if (args.includes("deploy")) {
          writeFileSync(args[args.indexOf("--outfile") + 1], loaderUpload);
        } else await runCommand(command, args, { ...options, cwd });
      },
    }),
  );
  assert.equal(existsSync(marker), false, "ignored dotenv must not change the runtime");
  assert.equal(evidence.runs.length, 3);
  assertCommands(evidence.identity.commands, calls, cwd);
  assert.equal(evidence.status, "pass");
});

test("modified controlled dotenv cannot yield evidence", async () => {
  const outdir = mkdtempSync(join(tmp, "changed-dotenv-"));
  let calls = 0;
  await assert.rejects(
    collect({
      outdir,
      budget: BUDGET,
      identity: {},
      cli: "/fixture/cli",
      run: async () => {
        calls++;
        chmodSync(join(outdir, "empty.env"), 0o600);
        writeFileSync(join(outdir, "empty.env"), "MINIFLARE_WORKERD_PATH=fixture\n");
      },
    }),
    /Startup dotenv control changed/,
  );
  assert.equal(calls, 1);
});

describe("runCommand", () => {
  const node = process.execPath;
  test("resolves on exit 0", async () => {
    await runCommand(node, ["-e", "console.log('ok')"], { timeoutMs: 10000 });
  });
  test("sets non-interactive, metrics-off environment", async () => {
    await runCommand(
      node,
      [
        "-e",
        "if (process.env.CI!=='true'||process.env.WRANGLER_SEND_METRICS!=='false') process.exit(3)",
      ],
      { timeoutMs: 10000 },
    );
  });
  test("does not inherit runtime override variables", async () => {
    const names = {
      MINIFLARE_WORKERD_PATH: "/nonexistent/workerd",
      MINIFLARE_WORKERD_V8_FLAGS: "--harmless",
      NODE_OPTIONS: "--no-warnings",
      NODE_PATH: "/nonexistent/node_modules",
      ESBUILD_BINARY_PATH: "/nonexistent/esbuild",
    };
    const saved = Object.fromEntries(Object.keys(names).map((k) => [k, process.env[k]]));
    Object.assign(process.env, names);
    try {
      const script = `const n=${JSON.stringify(Object.keys(names))};
const leaked=n.filter((k)=>k in process.env);
if (leaked.length) { process.exit(3); }`;
      await runCommand(node, ["-e", script], { timeoutMs: 10000 });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
  test("rejects on nonzero exit", async () => {
    await assert.rejects(
      runCommand(node, ["-e", "process.exit(3)"], { timeoutMs: 10000 }),
      /failed, timed out or exceeded output cap/,
    );
  });
  test("rejects on signal exit", async () => {
    await assert.rejects(
      runCommand(node, ["-e", "process.kill(process.pid,'SIGTERM')"], { timeoutMs: 10000 }),
      /failed/,
    );
  });
  test("kills and rejects on timeout", async () => {
    const started = Date.now();
    await assert.rejects(
      runCommand(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 }),
      /timed out/,
    );
    assert.ok(Date.now() - started < 8000);
  });
  test("timeout kills the whole process group including grandchildren", async () => {
    const pidFile = join(tmp, "grandchild.pid");
    const script = `const {spawn}=require('node:child_process');const fs=require('node:fs');
const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`;
    await assert.rejects(runCommand(node, ["-e", script], { timeoutMs: 700 }), /timed out/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    // Positive proof: the liveness probe reports a genuinely running process as live.
    const control = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    try {
      assert.equal(isLive(control.pid), true, "liveness probe must detect a running process");
    } finally {
      control.kill("SIGKILL");
    }
    let alive = true;
    for (let i = 0; i < 50 && alive; i++) {
      alive = isLive(pid);
      if (alive) await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(alive, false, "grandchild survived");
  });
  test("kills and rejects when output exceeds the cap", async () => {
    await assert.rejects(
      runCommand(
        node,
        ["-e", "const b='x'.repeat(400);setInterval(()=>process.stdout.write(b),5)"],
        { timeoutMs: 10000, maxBytes: 1000 },
      ),
      /output cap/,
    );
  });
  test("stderr counts toward the output cap", async () => {
    await assert.rejects(
      runCommand(
        node,
        ["-e", "const b='x'.repeat(400);setInterval(()=>process.stderr.write(b),5)"],
        { timeoutMs: 10000, maxBytes: 1000 },
      ),
      /output cap/,
    );
  });
  test("output under the cap succeeds", async () => {
    await runCommand(node, ["-e", "process.stdout.write('x'.repeat(500))"], {
      timeoutMs: 10000,
      maxBytes: 1000,
    });
  });
  test("rejects with a generic message on ENOENT", async () => {
    await assert.rejects(runCommand(join(tmp, "does-not-exist"), []), (e) => {
      assert.match(e.message, /Startup measurement command unavailable/);
      assert.doesNotMatch(e.message, /does-not-exist/);
      return true;
    });
  });
  test("does not leak child output into the rejection", async () => {
    await assert.rejects(
      runCommand(node, ["-e", "console.error('SECRET_BINDING_VALUE');process.exit(1)"], {
        timeoutMs: 10000,
      }),
      (e) => !/SECRET/.test(e.message),
    );
  });
});

describe("runCommand parent signal cleanup", () => {
  const node = process.execPath;
  const modulePath = fileURLToPath(new URL("./check-worker-startup.mjs", import.meta.url));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (predicate, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (predicate()) return true;
      await sleep(25);
    }
    return predicate();
  };
  const readPid = (file) => {
    try {
      const n = Number(readFileSync(file, "utf8").trim());
      return Number.isInteger(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  const grandchildSource = `require("node:fs").writeFileSync(process.argv[1], String(process.pid));
setInterval(() => {}, 1000);`;
  const childSource = `const fs = require("node:fs");
const { spawn } = require("node:child_process");
const dir = process.argv[2];
fs.writeFileSync(dir + "/child.pid", String(process.pid));
spawn(process.execPath, ["-e", ${JSON.stringify(grandchildSource)}, dir + "/grandchild.pid"], {
  stdio: "ignore",
});
fs.writeFileSync(dir + "/child.ready", "1");
setInterval(() => {}, 1000);`;

  function setup(name) {
    const dir = mkdtempSync(join(tmp, `${name}-`));
    writeFileSync(join(dir, "child.js"), childSource);
    return dir;
  }
  function parentSource(dir) {
    return `import { runCommand } from ${JSON.stringify(modulePath)};
import { writeFileSync } from "node:fs";
const before = process.listenerCount("SIGINT") + ":" + process.listenerCount("SIGTERM");
const p = runCommand(${JSON.stringify(node)}, [${JSON.stringify(join(dir, "child.js"))}, ${JSON.stringify(dir)}], { timeoutMs: 60000 });
writeFileSync(${JSON.stringify(join(dir, "parent.ready"))}, "1");
try {
  await p;
  writeFileSync(${JSON.stringify(join(dir, "success.marker"))}, "ok");
} catch {
  writeFileSync(${JSON.stringify(join(dir, "rejected.marker"))}, "rejected");
}
process.exit(process.exitCode ?? 0);`;
  }
  function killIfLive(pid) {
    if (pid && isLive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    test(`parent ${signal} terminates the child and grandchild`, { timeout: 30000 }, async () => {
      const dir = setup(`sig-${signal}`);
      writeFileSync(join(dir, "parent.mjs"), parentSource(dir));
      const parent = spawn(node, [join(dir, "parent.mjs")], { stdio: "ignore" });
      const exited = new Promise((resolve) =>
        parent.on("exit", (code, sig) => resolve({ code, sig })),
      );
      let childPid = 0;
      let grandchildPid = 0;
      try {
        const ready = await waitFor(() => {
          childPid = readPid(join(dir, "child.pid"));
          grandchildPid = readPid(join(dir, "grandchild.pid"));
          return childPid && grandchildPid && readPid(join(dir, "child.ready"));
        }, 15000);
        assert.ok(ready, "child and grandchild did not become ready");
        assert.ok(isLive(childPid) && isLive(grandchildPid));
        parent.kill(signal);
        let timer;
        const result = await Promise.race([
          exited,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("parent did not exit after signal")), 10000);
          }),
        ]).finally(() => clearTimeout(timer));
        assert.ok(result.sig || result.code !== 0, `parent exited 0 after ${signal}`);
        assert.equal(existsSync(join(dir, "success.marker")), false);
        assert.equal(existsSync(join(dir, "rejected.marker")), true);
        const gone = await waitFor(() => !isLive(childPid) && !isLive(grandchildPid), 5000);
        assert.ok(
          gone,
          `leaked after ${signal}: child live=${isLive(childPid)} grandchild live=${isLive(grandchildPid)}`,
        );
      } finally {
        killIfLive(childPid);
        killIfLive(grandchildPid);
        killIfLive(parent.pid);
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  test("signal listeners are removed after the command settles", { timeout: 30000 }, async () => {
    const before = ["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s));
    await runCommand(node, ["-e", "process.exit(0)"], { timeoutMs: 10000 });
    assert.deepEqual(
      ["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s)),
      before,
    );
    await assert.rejects(runCommand(node, ["-e", "process.exit(1)"], { timeoutMs: 10000 }));
    assert.deepEqual(
      ["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s)),
      before,
    );
    await assert.rejects(runCommand(node, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 200 }));
    assert.deepEqual(
      ["SIGINT", "SIGTERM"].map((s) => process.listenerCount(s)),
      before,
    );
  });
});
