import { expect, vi } from "vitest";

export const DIAGNOSTIC_CHANNELS = ["log", "info", "debug", "warn", "error"] as const;
export type DiagnosticChannel = (typeof DIAGNOSTIC_CHANNELS)[number];

/**
 * `texts` and `incomplete` are read when the call happens, so a value scrubbed
 * after logging still counts as the leak it was when it was written.
 */
export type DiagnosticRecord = {
  channel: DiagnosticChannel;
  args: unknown[];
  texts: { path: string; text: string }[];
  incomplete: string[];
};

export type DiagnosticScan = {
  /** Where a marker was found. Labels are paths, never values. */
  hits: string[];
  /** Where inspection stopped early. Any entry means the stream proves nothing. */
  incomplete: string[];
};

const MAX_STEPS = 20_000;
const MAX_DEPTH = 24;
const WITHHELD = "[marker withheld]";

/** Spy on every console channel a Worker log line can use; calls stay in order and print nothing. */
export function captureDiagnosticStream(): DiagnosticRecord[] {
  const records: DiagnosticRecord[] = [];
  for (const channel of DIAGNOSTIC_CHANNELS) {
    vi.spyOn(console, channel).mockImplementation((...args: unknown[]) => {
      records.push({ channel, args, ...inspect(args, `${channel}[${records.length}]`) });
    });
  }
  return records;
}

export function channelCounts(records: DiagnosticRecord[]): Record<DiagnosticChannel, number> {
  const counts = { log: 0, info: 0, debug: 0, warn: 0, error: 0 };
  for (const record of records) counts[record.channel] += 1;
  return counts;
}

const isObject = (value: unknown): value is object =>
  (typeof value === "object" && value !== null) || typeof value === "function";

/** Only shapes whose every readable value is visible here; anything with hidden state is opaque. */
function isInspectable(value: object): boolean {
  if (Array.isArray(value)) return true;
  if (value instanceof Error || value instanceof Map || value instanceof Set) return true;
  if (value instanceof RegExp) return true;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The built-in prototype an inspectable subclass chain must end at. */
function builtinPrototypeFor(value: object): object | null {
  if (Array.isArray(value)) return Array.prototype;
  if (value instanceof Error) return Error.prototype;
  if (value instanceof Map) return Map.prototype;
  if (value instanceof Set) return Set.prototype;
  if (value instanceof RegExp) return RegExp.prototype;
  return null;
}

/**
 * Intermediate prototypes between a value and its built-in prototype, in
 * chain order. Both the formatter check and the constructor-name read use
 * this one walk so the two cannot drift apart. Anything unreadable fails
 * closed with "prototype unreadable".
 */
function intermediatePrototypes(value: object): { chain: object[] } | { unreadable: string } {
  let builtin: object | null;
  try {
    builtin = builtinPrototypeFor(value);
  } catch {
    return { unreadable: "prototype unreadable" };
  }
  if (builtin === null) return { chain: [] };
  const chain: object[] = [];
  let proto: object | null;
  try {
    proto = Object.getPrototypeOf(value);
  } catch {
    return { unreadable: "prototype unreadable" };
  }
  while (proto !== null && proto !== builtin) {
    chain.push(proto);
    try {
      proto = Object.getPrototypeOf(proto);
    } catch {
      return { unreadable: "prototype unreadable" };
    }
  }
  return { chain };
}

/**
 * A subclass can print through prototype state that own-state reads miss: a
 * formatter (`%s` calls `toString`, `util.inspect` calls
 * `nodejs.util.inspect.custom`), a data value (`Symbol.toStringTag` prints as
 * `[tag]`, any other plain value prints under `%o`), or the constructor name
 * (Map/Array tag `Name(n)`, Error stack prefix `Name: message`). Walk each
 * intermediate prototype up to the built-in one; any own key there (other than
 * `constructor`) means the printed form is not fully visible here. Returns a
 * reason when opaque, null when the chain is clean.
 * Ruling: Error `name`, `message`, `stack` and `cause` are read explicitly via
 * `Reflect.get` (so a prototype accessor for one of those still reports its hit
 * and is not treated as hidden state); every other prototype own key is opaque.
 * Constructor names are read as text separately in `inspect`, so a marker in
 * the name is a hit. Mark incomplete but keep reading own state, so a covered
 * Error field still reports its hit; either entry alone fails the clean check.
 */
function prototypeFormatterReason(value: object): string | null {
  const walked = intermediatePrototypes(value);
  if ("unreadable" in walked) return walked.unreadable;
  for (const current of walked.chain) {
    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(current);
    } catch {
      return "prototype unreadable";
    }
    const isError = value instanceof Error;
    for (const key of keys) {
      if (key === "constructor") continue;
      if (isError && (key === "name" || key === "message" || key === "stack" || key === "cause")) {
        continue;
      }
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(current, key);
      } catch {
        return "prototype unreadable";
      }
      if (!descriptor) continue;
      return "opaque prototype formatter";
    }
  }
  return null;
}

/** Reads every string a call can print, now, and lists each place that cannot be read. */
function inspect(args: unknown[], prefix: string): Pick<DiagnosticRecord, "texts" | "incomplete"> {
  const texts: DiagnosticRecord["texts"] = [];
  const incomplete = new Set<string>();
  const seen = new WeakSet<object>();
  let steps = 0;
  let spent = false;

  const stop = (path: string, reason: string) => {
    incomplete.add(`${path}: ${reason}`);
  };

  const visit = (value: unknown, path: string, depth: number): void => {
    if (spent) return;
    steps += 1;
    if (steps > MAX_STEPS) {
      spent = true;
      stop(path, "step budget exhausted");
      return;
    }
    if (typeof value === "string") {
      texts.push({ path, text: value });
      return;
    }
    if (typeof value === "symbol") {
      texts.push({ path, text: value.description ?? "" });
      return;
    }
    if (typeof value === "function") return stop(path, "opaque function");
    if (!isObject(value)) return;
    if (seen.has(value)) return;
    seen.add(value);
    if (depth > MAX_DEPTH) return stop(path, "depth limit");
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value))
      return stop(path, "binary payload");
    if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise)
      return stop(path, "opaque object");

    let inspectable: boolean;
    try {
      inspectable = isInspectable(value);
    } catch {
      return stop(path, "prototype unreadable");
    }
    if (!inspectable) return stop(path, "opaque object");
    try {
      const formatter = prototypeFormatterReason(value);
      if (formatter) stop(path, formatter);
    } catch {
      return stop(path, "prototype unreadable");
    }
    // Node prints the subclass constructor name (Map/Array `Name(n)` tag, Error
    // stack prefix `Name: message`) but own-state reads never see it. Read each
    // intermediate constructor's `name` as text so a marker there is a hit;
    // anything unreadable or non-string fails closed.
    try {
      const walked = intermediatePrototypes(value);
      if ("unreadable" in walked) {
        stop(path, walked.unreadable);
      } else {
        for (const currentNode of walked.chain) {
          let ctorDescriptor: PropertyDescriptor | undefined;
          try {
            ctorDescriptor = Reflect.getOwnPropertyDescriptor(currentNode, "constructor");
          } catch {
            stop(path, "prototype unreadable");
            break;
          }
          if (ctorDescriptor) {
            if ("value" in ctorDescriptor) {
              const ctor = ctorDescriptor.value;
              if (typeof ctor === "function") {
                let nameDescriptor: PropertyDescriptor | undefined;
                try {
                  nameDescriptor = Reflect.getOwnPropertyDescriptor(ctor, "name");
                } catch {
                  stop(path, "prototype unreadable");
                }
                if (nameDescriptor) {
                  if ("value" in nameDescriptor) {
                    if (typeof nameDescriptor.value === "string") {
                      if (nameDescriptor.value.length > 0) {
                        texts.push({ path: `${path}.<constructor>`, text: nameDescriptor.value });
                      }
                    } else {
                      stop(path, "opaque prototype formatter");
                    }
                  } else {
                    stop(path, "opaque prototype formatter");
                  }
                }
              } else {
                if (typeof ctor === "string") {
                  texts.push({ path: `${path}.<constructor>`, text: ctor });
                }
                stop(path, "opaque prototype formatter");
              }
            } else {
              stop(path, "opaque prototype formatter");
            }
          }
        }
      }
    } catch {
      stop(path, "prototype unreadable");
    }
    if (value instanceof RegExp) texts.push({ path, text: value.source });

    const readInto = (key: PropertyKey, childPath: string) => {
      let got: unknown;
      try {
        got = Reflect.get(value, key);
      } catch {
        return stop(childPath, "getter threw");
      }
      visit(got, childPath, depth + 1);
    };

    if (value instanceof Error) {
      for (const key of ["name", "message", "stack", "cause"]) readInto(key, `${path}.${key}`);
    }
    if (value instanceof Map) {
      try {
        for (const [key, entry] of value) {
          visit(key, `${path}<key>`, depth + 1);
          visit(entry, `${path}<value>`, depth + 1);
        }
      } catch {
        return stop(path, "collection unreadable");
      }
    }
    if (value instanceof Set) {
      try {
        for (const member of value) visit(member, `${path}<member>`, depth + 1);
      } catch {
        return stop(path, "collection unreadable");
      }
    }

    let keys: (string | symbol)[];
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      return stop(path, "keys unreadable");
    }
    for (const key of keys) {
      texts.push({
        path: `${path}.<key>`,
        text: typeof key === "symbol" ? (key.description ?? "") : key,
      });
      const childPath = `${path}.${typeof key === "symbol" ? "<symbol>" : key}`;
      let descriptor: PropertyDescriptor | undefined;
      try {
        descriptor = Reflect.getOwnPropertyDescriptor(value, key);
      } catch {
        stop(childPath, "descriptor unreadable");
        continue;
      }
      if (!descriptor) continue;
      if ("value" in descriptor) visit(descriptor.value, childPath, depth + 1);
      else readInto(key, childPath);
    }
    return undefined;
  };

  args.forEach((arg, position) => visit(arg, `${prefix}.args[${position}]`, 0));
  return { texts, incomplete: [...incomplete] };
}

/**
 * Finds each marker in every string read from the stream, and in the joined text of one call so a
 * marker split across `%s` arguments still counts. Labels never carry a marker.
 */
export function scanDiagnosticStream(
  records: DiagnosticRecord[],
  markers: readonly string[],
): DiagnosticScan {
  const hits = new Set<string>();
  const incomplete = new Set<string>();
  const hides = (text: string) => markers.some((marker) => text.includes(marker));
  const label = (path: string) => (hides(path) ? "[label withheld]" : path);

  records.forEach((record, index) => {
    for (const { path, text } of record.texts) {
      if (hides(text)) hits.add(label(path));
    }
    const joined = record.texts.map(({ text }) => text).join("");
    if (!record.texts.some(({ text }) => hides(text)) && hides(joined)) {
      hits.add(label(`${record.channel}[${index}] (split across values)`));
    }
    for (const entry of record.incomplete) incomplete.add(label(entry));
  });
  return { hits: [...hits].sort(), incomplete: [...incomplete].sort() };
}

function requestRouteOf(record: DiagnosticRecord): string | undefined {
  if (record.channel !== "log" || typeof record.args[0] !== "string") return undefined;
  let line: unknown;
  try {
    line = JSON.parse(record.args[0]);
  } catch {
    return undefined;
  }
  const { event, route } = (line ?? {}) as { event?: unknown; route?: unknown };
  return event === "http.request" && typeof route === "string" ? route : undefined;
}

/** Routes on JSON console records with the middleware request event and route fields. */
export function requestRoutes(records: DiagnosticRecord[]): string[] {
  return records.flatMap((record) => requestRouteOf(record) ?? []);
}

/**
 * Fails unless a request record for `request` is present, each expected record appears exactly
 * once, and every value was inspected to the end with no marker found. Assertions carry counts and
 * labels only, so a failure never prints marker bytes.
 */
export function expectDiagnosticStreamClean(
  records: DiagnosticRecord[],
  markers: readonly string[],
  { request, messages = [] }: { request: string; messages?: readonly string[] },
): void {
  expect(requestRoutes(records), `request record present for ${request}`).toContain(request);
  for (const message of messages) {
    expect(
      records.filter((record) => record.args[0] === message).length,
      `expected record written once: ${message}`,
    ).toBe(1);
  }
  const scan = scanDiagnosticStream(records, markers);
  expect(scan.incomplete, "every diagnostic value inspected to the end").toEqual([]);
  expect(scan.hits, "marker found in diagnostic stream (labels only)").toEqual([]);
}

// Long enough that ordinary metadata never shares a run with a canary; shorter fragments can show.
const FRAGMENT = 8;

/**
 * Marker-free copy for deep-equal diffs. Object properties are read as descriptors, so accessors
 * are never invoked; arrays and collections are read directly and any throw becomes an
 * "[unreadable]" entry. A string sharing a run of eight characters with a marker is withheld, so a
 * diff cannot rebuild a canary from pieces embedded in other text. Shorter fragments are shown.
 */
export function withheld(value: unknown, markers: readonly string[]): unknown {
  const active = new Set<object>();
  const hides = (text: string) =>
    markers.some((marker) => {
      if (text.includes(marker)) return true;
      for (let start = 0; start + FRAGMENT <= text.length; start++) {
        if (marker.includes(text.slice(start, start + FRAGMENT))) return true;
      }
      return false;
    });
  const text = (value: string | symbol): string => {
    if (typeof value === "string") return hides(value) ? WITHHELD : value;
    const description = value.description ?? "";
    return hides(description) ? WITHHELD : value.toString();
  };

  const copy = (node: unknown): unknown => {
    if (typeof node === "string" || typeof node === "symbol") return text(node);
    if (typeof node === "function") return "[function]";
    if (!isObject(node)) return node;
    if (active.has(node)) return "[circular]";
    active.add(node);
    try {
      if (Array.isArray(node)) return node.map((entry) => copy(entry));
      if (node instanceof Map) return [...node].map(([key, entry]) => [copy(key), copy(entry)]);
      if (node instanceof Set) return [...node].map((member) => copy(member));
      const out: Record<string, unknown> = {};
      for (const key of Reflect.ownKeys(node)) {
        if (!Object.prototype.propertyIsEnumerable.call(node, key)) continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(node, key);
        out[text(key)] =
          descriptor && "value" in descriptor ? copy(descriptor.value) : "[accessor withheld]";
      }
      return out;
    } catch {
      return "[unreadable]";
    } finally {
      active.delete(node);
    }
  };
  return copy(value);
}
