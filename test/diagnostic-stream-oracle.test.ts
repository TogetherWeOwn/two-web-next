// The failure-stream oracle must read every channel and field it claims to inspect.
// These negative controls plant the leaks it must catch and the benign shapes it must accept.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  captureDiagnosticStream,
  channelCounts,
  expectDiagnosticStreamClean,
  scanDiagnosticStream,
  withheld,
} from "./helpers/diagnostic-stream";

const MARK = "***synthetic-marker-9q2w***";
const MARKERS = [MARK];
const ROUTE = "/fixture/callback";

/** The line the request middleware writes; the oracle counts only lines shaped like this. */
const requestLine = (route: string) =>
  JSON.stringify({ event: "http.request", route, status: 302 });

function cyclicWith(marker: string): Record<string, unknown> {
  const record: Record<string, unknown> = { status: 400, detail: marker };
  record.self = record;
  return record;
}

function benignCyclic(): Record<string, unknown> {
  const record: Record<string, unknown> = { status: 400 };
  record.self = record;
  return record;
}

class AccessorMessageError extends Error {}
Object.defineProperty(AccessorMessageError.prototype, "message", {
  get: () => MARK,
});

// Local fixtures only: subclasses whose prototype carries a formatter that
// Node's %s / util.inspect would print, but own-state reads would miss.
class PrototypeToStringError extends Error {
  toString(): string {
    return MARK;
  }
}
class PrototypeToStringMap extends Map<string, string> {
  toString(): string {
    return MARK;
  }
}
class PrototypeToStringSet extends Set<string> {
  toString(): string {
    return MARK;
  }
}
class PrototypeToStringRegExp extends RegExp {
  toString(): string {
    return MARK;
  }
}
class PrototypeToStringArray extends Array<string> {
  toString(): string {
    return MARK;
  }
}
class PrototypeCustomInspectError extends Error {
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return MARK;
  }
}
class PrototypeAccessorMap extends Map<string, string> {
  get detail(): string {
    return MARK;
  }
}
class PrototypeTagDataMap extends Map<string, string> {}
Object.defineProperty(PrototypeTagDataMap.prototype, Symbol.toStringTag, { value: MARK });
class PrototypeDataMap extends Map<string, string> {}
Object.defineProperty(PrototypeDataMap.prototype, "detail", {
  value: MARK,
  enumerable: true,
  writable: true,
  configurable: true,
});

// Two-level chains: the walk must flag prototype state on any intermediate
// prototype, not just the first or last level.
class GrandparentToStringMap extends Map<string, string> {
  toString(): string {
    return MARK;
  }
}
class ChildOfFormatterGrandparentMap extends GrandparentToStringMap {}
class CleanParentMap extends Map<string, string> {}
class ChildFormatterMap extends CleanParentMap {
  toString(): string {
    return MARK;
  }
}
class GrandparentTagMap extends Map<string, string> {}
Object.defineProperty(GrandparentTagMap.prototype, Symbol.toStringTag, { value: MARK });
class ChildOfTagGrandparentMap extends GrandparentTagMap {}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("diagnostic stream capture", () => {
  it("records every named console channel in call order", () => {
    const records = captureDiagnosticStream();
    console.log("a");
    console.info("b");
    console.debug("c");
    console.warn("d");
    console.error("e");
    expect(records.map((r) => r.channel)).toEqual(["log", "info", "debug", "warn", "error"]);
    expect(channelCounts(records)).toEqual({ log: 1, info: 1, debug: 1, warn: 1, error: 1 });
  });

  it("finds a marker written to each channel, console.log included", () => {
    const records = captureDiagnosticStream();
    console.log(`planted ${MARK}`);
    console.info(`planted ${MARK}`);
    console.debug(`planted ${MARK}`);
    console.warn(`planted ${MARK}`);
    console.error(`planted ${MARK}`);
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual([
      "debug[2].args[0]",
      "error[4].args[0]",
      "info[1].args[0]",
      "log[0].args[0]",
      "warn[3].args[0]",
    ]);
  });

  it("inspects an Error's message, stack and nested cause", () => {
    const records = captureDiagnosticStream();
    console.warn("outer", new Error(`message ${MARK}`));
    const stackOnly = new Error("plain");
    stackOnly.stack = `Error: plain\n    at ${MARK}`;
    console.error("stack", stackOnly);
    console.warn("cause", new Error("outer", { cause: new Error(`inner ${MARK}`) }));
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(
      expect.arrayContaining([
        "warn[0].args[1].message",
        "error[1].args[1].stack",
        "warn[2].args[1].cause.message",
      ]),
    );
  });

  it("reads an Error message supplied by a prototype accessor", () => {
    const records = captureDiagnosticStream();
    const err = new AccessorMessageError();
    err.stack = "AccessorMessageError";
    console.warn("accessor", err);
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["warn[0].args[1].message"]);
  });

  it("finds a marker in a non-enumerable property", () => {
    const records = captureDiagnosticStream();
    console.warn(
      "hidden",
      Object.defineProperty({ status: 400 }, "raw", { value: MARK, enumerable: false }),
    );
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["warn[0].args[1].raw"]);
  });

  it("finds markers in Map values, Set members and symbol-keyed properties", () => {
    const records = captureDiagnosticStream();
    console.debug("collections", new Map([["k", MARK]]), new Set([MARK]), { [Symbol("s")]: MARK });
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual([
      "debug[0].args[1]<value>",
      "debug[0].args[2]<member>",
      "debug[0].args[3].<symbol>",
    ]);
  });

  it("finds a marker held as a symbol value", () => {
    const records = captureDiagnosticStream();
    console.warn("symbol", Symbol(MARK));
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["warn[0].args[1]"]);
  });

  it("finds a marker used as a Map key", () => {
    const records = captureDiagnosticStream();
    console.debug("keys", new Map([[MARK, 1]]));
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["debug[0].args[1]<key>"]);
  });

  it("finds a marker in a symbol key's description", () => {
    const records = captureDiagnosticStream();
    console.warn("symkey", { [Symbol(MARK)]: 1 });
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["warn[0].args[1].<key>"]);
  });

  it("finds a marker returned by an own accessor", () => {
    const records = captureDiagnosticStream();
    console.info("accessor", {
      get detail(): string {
        return MARK;
      },
    });
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["info[0].args[1].detail"]);
  });

  it("reads each value when the call happens, so a later scrub cannot hide the leak", () => {
    const records = captureDiagnosticStream();
    const detail = { value: MARK };
    const err = new Error(MARK);
    console.warn("scrubbed", detail, err);
    detail.value = "[redacted]";
    err.message = "ok";
    err.stack = "Error: ok";
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(
      expect.arrayContaining(["warn[0].args[1].value", "warn[0].args[2].message"]),
    );
  });

  it("finds a marker split across the values of one call", () => {
    const records = captureDiagnosticStream();
    console.warn("%s%s", MARK.slice(0, 10), MARK.slice(10));
    expect(scanDiagnosticStream(records, MARKERS).hits).toEqual(["warn[0] (split across values)"]);
  });

  it("terminates on a cyclic record and still finds a marker inside it", () => {
    const records = captureDiagnosticStream();
    console.warn("cycle", cyclicWith(MARK));
    const scan = scanDiagnosticStream(records, MARKERS);
    expect(scan.incomplete).toEqual([]);
    expect(scan.hits).toEqual(["warn[0].args[1].detail"]);
  });

  it("terminates on cyclic Error causes and self-containing Maps, finding the marker", () => {
    const records = captureDiagnosticStream();
    const inner = new Error(MARK);
    const outer = new Error("outer", { cause: inner });
    inner.cause = outer;
    const holder = new Map<string, unknown>();
    holder.set("self", holder);
    holder.set("detail", MARK);
    console.warn("cycles", outer, holder);
    const scan = scanDiagnosticStream(records, MARKERS);
    expect(scan.incomplete).toEqual([]);
    expect(scan.hits).toEqual(
      expect.arrayContaining(["warn[0].args[1].cause.message", "warn[0].args[2]<value>"]),
    );
  });

  it("reports a benign cyclic record as complete and marker-free", () => {
    const records = captureDiagnosticStream();
    console.info("benign", benignCyclic());
    expect(scanDiagnosticStream(records, MARKERS)).toEqual({ hits: [], incomplete: [] });
  });

  it("withholds marker bytes from labels when the marker is a property name", () => {
    const records = captureDiagnosticStream();
    console.warn("key", { [MARK]: MARK });
    const { hits } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toHaveLength(2);
    expect(hits.some((hit) => hit.includes(MARK))).toBe(false);
  });

  it("marks a throwing getter as incomplete rather than clean", () => {
    const records = captureDiagnosticStream();
    console.warn("getter", {
      get detail(): string {
        throw new Error("getter");
      },
    });
    expect(scanDiagnosticStream(records, MARKERS)).toEqual({
      hits: [],
      incomplete: ["warn[0].args[1].detail: getter threw"],
    });
  });

  it("reports a truncated walk as incomplete, never clean", () => {
    const records = captureDiagnosticStream();
    console.info(
      "bulk",
      Array.from({ length: 25_000 }, () => "ok"),
    );
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("step budget exhausted");
  });

  it("reports a marker beyond the depth limit as incomplete, never clean", () => {
    const records = captureDiagnosticStream();
    let deep: Record<string, unknown> = { token: MARK };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    console.warn("deep", deep);
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete.length).toBeGreaterThan(0);
  });

  it("reports binary payloads as uninspectable", () => {
    const records = captureDiagnosticStream();
    console.warn("bytes", new TextEncoder().encode(MARK));
    expect(scanDiagnosticStream(records, MARKERS)).toEqual({
      hits: [],
      incomplete: ["warn[0].args[1]: binary payload"],
    });
  });

  it.each([
    ["a URL", () => new URL(`https://example.test/?t=${MARK}`)],
    ["Headers", () => new Headers({ "x-token": MARK })],
    ["a String wrapper", () => Object(MARK)],
    ["a function", () => function leak() {}],
  ])("reports %s as opaque, never clean", (_name, value) => {
    const records = captureDiagnosticStream();
    console.warn("opaque", value());
    const { incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it.each([
    [
      "Error subclass",
      () => {
        const err = new PrototypeToStringError("ok");
        err.stack = "PrototypeToStringError: ok";
        return err;
      },
    ],
    ["Map subclass", () => new PrototypeToStringMap([["k", "v"]])],
    ["Set subclass", () => new PrototypeToStringSet(["v"])],
    ["RegExp subclass", () => new PrototypeToStringRegExp("ok")],
    ["Array subclass", () => new PrototypeToStringArray("ok")],
  ])("reports a %s toString override as opaque, never clean", (_name, value) => {
    const records = captureDiagnosticStream();
    console.warn("opaque", value());
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it("reports a prototype nodejs.util.inspect.custom as opaque, never clean", () => {
    const records = captureDiagnosticStream();
    const err = new PrototypeCustomInspectError("ok");
    err.stack = "PrototypeCustomInspectError: ok";
    console.warn("opaque", err);
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it("reports a prototype accessor as opaque, never clean", () => {
    const records = captureDiagnosticStream();
    console.warn("opaque", new PrototypeAccessorMap([["k", "v"]]));
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it("reports a prototype Symbol.toStringTag as opaque, never clean", () => {
    const records = captureDiagnosticStream();
    console.warn("opaque", new PrototypeTagDataMap([["k", "v"]]));
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it("reports a prototype data property as opaque, never clean", () => {
    const records = captureDiagnosticStream();
    console.warn("opaque", new PrototypeDataMap([["k", "v"]]));
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it.each([
    ["grandparent toString", () => new ChildOfFormatterGrandparentMap([["k", "v"]])],
    ["child toString over a clean parent", () => new ChildFormatterMap([["k", "v"]])],
    ["grandparent Symbol.toStringTag", () => new ChildOfTagGrandparentMap([["k", "v"]])],
  ])("reports a two-level chain %s as opaque, never clean", (_name, value) => {
    const records = captureDiagnosticStream();
    console.warn("opaque", value());
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });

  it("reports a renamed grandparent constructor in a two-level chain as a hit", () => {
    class RenamedGrandparentMap extends Map<string, string> {}
    Object.defineProperty(RenamedGrandparentMap, "name", { value: MARK, configurable: true });
    class ChildOfRenamedGrandparentMap extends RenamedGrandparentMap {}
    const records = captureDiagnosticStream();
    console.warn("opaque", new ChildOfRenamedGrandparentMap([["k", "v"]]));
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual(["warn[0].args[1].<constructor>"]);
    expect(incomplete).toEqual([]);
  });

  it.each([
    [
      "Error",
      () => {
        class RenamedError extends Error {}
        Object.defineProperty(RenamedError, "name", { value: MARK, configurable: true });
        const err = new RenamedError("ok");
        err.stack = "RenamedError: ok";
        return err;
      },
    ],
    [
      "Map",
      () => {
        class RenamedMap extends Map<string, string> {}
        Object.defineProperty(RenamedMap, "name", { value: MARK, configurable: true });
        return new RenamedMap([["k", "v"]]);
      },
    ],
  ])("reports a renamed %s constructor as a hit, never clean", (_name, value) => {
    const records = captureDiagnosticStream();
    console.warn("opaque", value());
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual(["warn[0].args[1].<constructor>"]);
    expect(incomplete).toEqual([]);
  });

  it.each([
    [
      "static name method",
      () => {
        class StaticNameMethodMap extends Map<string, string> {
          static name(): string {
            return MARK;
          }
        }
        return new StaticNameMethodMap([["k", "v"]]);
      },
    ],
    [
      "static name getter",
      () => {
        class StaticNameGetterMap extends Map<string, string> {
          static get name(): string {
            return MARK;
          }
        }
        return new StaticNameGetterMap([["k", "v"]]);
      },
    ],
  ])("reports a Map subclass %s as opaque, never clean", (_name, value) => {
    const records = captureDiagnosticStream();
    console.warn("opaque", value());
    const { hits, incomplete } = scanDiagnosticStream(records, MARKERS);
    expect(hits).toEqual([]);
    expect(incomplete).toHaveLength(1);
    expect(incomplete[0]).toContain("opaque");
  });
});

describe("withheld", () => {
  it("replaces marker-bearing strings and keys, and keeps everything else", () => {
    expect(
      withheld(
        { exception: "DiscordError", detail: `x ${MARK}`, [`k ${MARK}`]: 1, status: 400 },
        MARKERS,
      ),
    ).toEqual({
      exception: "DiscordError",
      detail: "[marker withheld]",
      "[marker withheld]": 1,
      status: 400,
    });
  });

  it("terminates on a cyclic value and marks the back-reference", () => {
    const copy = withheld(cyclicWith(MARK), MARKERS) as Record<string, unknown>;
    expect(copy.self).toBe("[circular]");
    expect(copy.detail).toBe("[marker withheld]");
  });

  it("never invokes a getter, so a thrown marker cannot reach a failure message", () => {
    const hostile = {
      get detail(): string {
        throw new Error(MARK);
      },
    };
    const copy = withheld(hostile, MARKERS);
    expect(JSON.stringify(copy)).not.toContain(MARK);
  });

  it("withholds a fragment of a marker, so a diff cannot rebuild it from pieces", () => {
    expect(
      withheld({ head: MARK.slice(0, 10), tail: MARK.slice(10), status: 400 }, MARKERS),
    ).toEqual({ head: "[marker withheld]", tail: "[marker withheld]", status: 400 });
  });

  it("withholds a fragment embedded in other text", () => {
    expect(withheld({ leak: `x${MARK.slice(0, 10)}y` }, MARKERS)).toEqual({
      leak: "[marker withheld]",
    });
  });

  it("shows short strings and the empty string unchanged", () => {
    const shape = { empty: "", ok: "ok", kind: "expired_grant", status: 400 };
    expect(withheld(shape, MARKERS)).toEqual(shape);
  });

  it("reports an array whose element getter throws as unreadable, never printing the marker", () => {
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, 0, {
      enumerable: true,
      get(): never {
        throw new Error(MARK);
      },
    });
    expect(withheld(hostile, MARKERS)).toBe("[unreadable]");
  });

  it("withholds a symbol whose description carries the marker", () => {
    expect(withheld(Symbol(MARK), MARKERS)).toBe("[marker withheld]");
    expect(withheld(Symbol("ok"), MARKERS)).toBe("Symbol(ok)");
  });
});

describe("expectDiagnosticStreamClean", () => {
  it("passes a complete, marker-free stream with its request line and expected record", () => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    console.info("sign-in ok", { status: 302 });
    expect(() =>
      expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE, messages: ["sign-in ok"] }),
    ).not.toThrow();
  });

  it("passes a complete benign cyclic record", () => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    console.debug("leak", benignCyclic());
    expect(() => expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE })).not.toThrow();
  });

  it("fails without a route-shaped request record, even with no marker present", () => {
    const records = captureDiagnosticStream();
    console.log("request");
    expect(() => expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE })).toThrow(
      "request record present",
    );
  });

  it("fails when the expected positive record is absent", () => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    expect(() =>
      expectDiagnosticStreamClean(records, MARKERS, {
        request: ROUTE,
        messages: ["discord sign-in failed"],
      }),
    ).toThrow("expected record written once");
  });

  it("fails when inspection is incomplete even with no marker present", () => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    console.warn("getter", {
      get detail(): string {
        throw new Error("getter");
      },
    });
    expect(() => expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE })).toThrow(
      "every diagnostic value inspected",
    );
  });

  it.each([
    ["console.log", () => console.log("leak", `planted ${MARK}`)],
    ["console.info with an object field", () => console.info("leak", { detail: MARK })],
    ["console.debug with a cyclic record", () => console.debug("leak", cyclicWith(MARK))],
    [
      "console.warn with an Error message",
      () => console.warn("leak", new Error(`carries ${MARK}`)),
    ],
    [
      "console.error with a nested Error cause",
      () => console.error("leak", new Error("outer", { cause: new Error(`inner ${MARK}`) })),
    ],
    [
      "console.warn with a non-enumerable property",
      () => console.warn("leak", Object.defineProperty({}, "raw", { value: MARK })),
    ],
    [
      "console.warn with a prototype-accessor message",
      () => console.warn("leak", new AccessorMessageError()),
    ],
    [
      "console.warn with a marker split across arguments",
      () => console.warn("leak", MARK.slice(0, 10), MARK.slice(10)),
    ],
  ])("fails on a planted leak via %s, naming a label and never the marker", (_name, plant) => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    plant();
    let failure: unknown;
    try {
      expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE, messages: ["leak"] });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("marker found in diagnostic stream");
    expect((failure as Error).message).not.toContain(MARK);
  });

  it("fails when a logged value was scrubbed afterwards", () => {
    const records = captureDiagnosticStream();
    console.log(requestLine(ROUTE));
    const detail = { value: MARK };
    console.warn("leak", detail);
    detail.value = "[redacted]";
    expect(() => expectDiagnosticStreamClean(records, MARKERS, { request: ROUTE })).toThrow(
      "marker found in diagnostic stream",
    );
  });
});
