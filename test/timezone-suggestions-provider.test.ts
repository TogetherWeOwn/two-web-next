import { afterEach, describe, expect, it, vi } from "vitest";

// The browser asset relies on DOM globals the Workers tsconfig does not
// declare, so load it by variable path to keep it out of the typecheck graph.
const assetPath = "../assets/timezone-suggestions";
const { suggestTimezones } = (await import(/* @vite-ignore */ assetPath)) as {
  suggestTimezones: (input: unknown) => void;
};

// Fake DOM: the provider only touches input.list, list.options/appendChild and
// input.addEventListener, so a hand-made input pins its slicing and guards.
function fakeInput(opts: { throwList?: boolean; throwListen?: boolean } = {}) {
  const options: string[] = [];
  const focus: Array<() => void> = [];
  const list = {
    options,
    appendChild(option: { value: string }) {
      options.push(option.value);
    },
  };
  const input = {
    get list() {
      if (opts.throwList) throw new Error("list getter");
      return list;
    },
    addEventListener(type: string, fn: () => void) {
      if (opts.throwListen) throw new Error("listen");
      if (type === "focus") focus.push(fn);
    },
  };
  return { input, options, focus };
}

function stubIntl(values: unknown) {
  vi.stubGlobal(
    "Option",
    class {
      constructor(public value: string) {}
    },
  );
  vi.stubGlobal("Intl", {
    supportedValuesOf: () => values,
    DateTimeFormat: class {
      constructor(_l: string, o: { timeZone: string }) {
        if (o.timeZone.startsWith("bad")) throw new RangeError("bad zone");
      }
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("suggestTimezones provider", () => {
  it("offers a first slice at bind and completes on first focus only", () => {
    const zones = Array.from({ length: 100 }, (_, i) => `Z/${i}`);
    stubIntl(zones);
    const { input, options, focus } = fakeInput();
    suggestTimezones(input);
    expect(options).toHaveLength(32);
    expect(focus).toHaveLength(1);
    focus[0]?.();
    expect(options).toEqual(zones);
  });

  it("inspects at most 512 entries, so a valid zone beyond them is never offered", () => {
    const zones = [...Array.from({ length: 512 }, (_, i) => `bad/${i}`), "Valid/After"];
    stubIntl(zones);
    const { input, options, focus } = fakeInput();
    suggestTimezones(input);
    focus[0]?.();
    expect(options).toEqual([]);
  });

  it("offers a valid zone inside the 512 cap after invalid entries", () => {
    const zones = [...Array.from({ length: 500 }, (_, i) => `bad/${i}`), "Valid/Inside"];
    stubIntl(zones);
    const { input, options, focus } = fakeInput();
    suggestTimezones(input);
    focus[0]?.();
    expect(options).toEqual(["Valid/Inside"]);
  });

  it("does not throw when the list getter throws", () => {
    stubIntl(["A/B"]);
    const { input } = fakeInput({ throwList: true });
    expect(() => suggestTimezones(input)).not.toThrow();
  });

  it("does not throw when listener registration throws, and keeps the first slice", () => {
    stubIntl(["A/B"]);
    const { input, options } = fakeInput({ throwListen: true });
    expect(() => suggestTimezones(input)).not.toThrow();
    expect(options).toEqual(["A/B"]);
  });
});
