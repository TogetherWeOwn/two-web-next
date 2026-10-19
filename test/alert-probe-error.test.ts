import { describe, expect, it } from "vitest";
import { AlertProbeError, validProbeId } from "../src/alert-probe-error";

const VALID_V4 = "11111111-1111-4111-8111-111111111111";
const FIXED_MESSAGE = "synthetic staging alert probe";

const validCases = [
  { label: "variant 8", value: "11111111-1111-4111-8111-111111111111" },
  { label: "variant 9", value: "11111111-1111-4111-9111-111111111111" },
  { label: "variant a", value: "11111111-1111-4111-a111-111111111111" },
  { label: "variant b", value: "11111111-1111-4111-b111-111111111111" },
  { label: "field v4", value: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
];

const wrongVersionCases = [
  { label: "v1", value: "11111111-1111-1111-8111-111111111111" },
  { label: "v3", value: "11111111-1111-3111-8111-111111111111" },
  { label: "v5", value: "11111111-1111-5111-8111-111111111111" },
  { label: "v7", value: "11111111-1111-7111-8111-111111111111" },
  { label: "v0", value: "11111111-1111-0111-8111-111111111111" },
];

const wrongVariantCases = [
  { label: "variant 0", value: "11111111-1111-4111-0111-111111111111" },
  { label: "variant 7", value: "11111111-1111-4111-7111-111111111111" },
  { label: "variant c", value: "11111111-1111-4111-c111-111111111111" },
  { label: "variant f", value: "11111111-1111-4111-f111-111111111111" },
];

const malformedCases = [
  { label: "empty", value: "" },
  { label: "truncated", value: "11111111-1111-4111-8111-11111111111" },
  { label: "missing group", value: "11111111-1111-4111-8111" },
  { label: "overlong suffix", value: `${VALID_V4}a` },
  { label: "overlong group", value: `${VALID_V4}-aaaa` },
  { label: "padded spaces", value: ` ${VALID_V4} ` },
  { label: "leading newline", value: `\n${VALID_V4}` },
  { label: "trailing newline", value: `${VALID_V4}\n` },
  { label: "padded tabs", value: `\t${VALID_V4}\t` },
  { label: "missing dashes", value: VALID_V4.replaceAll("-", "") },
  { label: "short group", value: "1111111-1111-4111-8111-111111111111" },
  { label: "short group2", value: "11111111-111-4111-8111-111111111111" },
  { label: "long group2", value: "11111111-11111-4111-8111-111111111111" },
  { label: "short group3", value: "11111111-1111-411-8111-111111111111" },
  { label: "long group3", value: "11111111-1111-41111-8111-111111111111" },
  { label: "short group4", value: "11111111-1111-4111-811-111111111111" },
  { label: "long group4", value: "11111111-1111-4111-81111-111111111111" },
  { label: "non-hex", value: "g1111111-1111-4111-8111-111111111111" },
  { label: "non-hex group2", value: "11111111-111g-4111-8111-111111111111" },
  { label: "non-hex group3 tail", value: "11111111-1111-411g-8111-111111111111" },
  { label: "non-hex group4 tail", value: "11111111-1111-4111-811g-111111111111" },
  { label: "uppercase group2", value: "11111111-111A-4111-8111-111111111111" },
  { label: "uppercase variant alone", value: "11111111-1111-4111-A111-111111111111" },
  { label: "uppercase", value: "F47AC10B-58CC-4372-A567-0E02B2C3D479" },
  { label: "mixed case", value: "f47ac10B-58cc-4372-a567-0e02b2c3d479" },
  { label: "nil uuid", value: "00000000-0000-0000-0000-000000000000" },
  { label: "braced", value: `{${VALID_V4}}` },
  { label: "urn", value: `urn:uuid:${VALID_V4}` },
];

const nonStringCases: { label: string; value: unknown }[] = [
  { label: "undefined", value: undefined },
  { label: "null", value: null },
  { label: "number", value: 42 },
  { label: "zero", value: 0 },
  { label: "boolean", value: true },
  { label: "object", value: {} },
  { label: "array", value: [] },
  { label: "boxed string", value: new String(VALID_V4) },
];

describe("validProbeId accepts exactly UUIDv4", () => {
  it.each(validCases)("accepts $label $value", ({ value }) => {
    expect(validProbeId(value)).toBe(true);
  });

  it.each(wrongVersionCases)("rejects $label $value", ({ value }) => {
    expect(validProbeId(value)).toBe(false);
  });

  it.each(wrongVariantCases)("rejects $label $value", ({ value }) => {
    expect(validProbeId(value)).toBe(false);
  });

  it.each(malformedCases)("rejects $label", ({ value }) => {
    expect(validProbeId(value)).toBe(false);
  });

  it.each(nonStringCases)("rejects $label non-string", ({ value }) => {
    expect(validProbeId(value)).toBe(false);
  });
});

describe("AlertProbeError pins the fixed exception", () => {
  it.each(validCases)("keeps $label probeId with the fixed message", ({ value }) => {
    const err = new AlertProbeError(value);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AlertProbeError);
    expect(err.message).toBe(FIXED_MESSAGE);
    expect(err.message).not.toContain(value);
    expect(err.probeId).toBe(value);
  });

  it.each([...wrongVersionCases, ...wrongVariantCases])(
    "drops $label probeId but keeps the fixed message",
    ({ value }) => {
      const err = new AlertProbeError(value);
      expect(err.message).toBe(FIXED_MESSAGE);
      expect(err.probeId).toBeUndefined();
    },
  );

  it.each(malformedCases)("drops $label probeId but keeps the fixed message", ({ value }) => {
    const err = new AlertProbeError(value);
    expect(err.message).toBe(FIXED_MESSAGE);
    expect(err.probeId).toBeUndefined();
  });

  it("drops a missing probeId but keeps the fixed message", () => {
    for (const err of [new AlertProbeError(), new AlertProbeError(undefined)]) {
      expect(err.message).toBe(FIXED_MESSAGE);
      expect(err.probeId).toBeUndefined();
    }
  });

  it.each(nonStringCases.filter((c) => c.label !== "undefined"))(
    "drops $label probeId but keeps the fixed message",
    ({ value }) => {
      const err = new AlertProbeError(value as unknown as string);
      expect(err.message).toBe(FIXED_MESSAGE);
      expect(err.probeId).toBeUndefined();
    },
  );
});
