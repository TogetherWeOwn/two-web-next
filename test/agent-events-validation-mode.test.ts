import { describe, expect, it } from "vitest";
import { validateFields } from "../src/agent-events/payload";

const FIELDS = {
  title: "Validation mode proof",
  starts_at: "2099-10-25 01:45",
  ends_at: "2099-10-25 01:15",
  timezone: "Europe/London",
  location: "Voice",
};

describe("agent event field validation mode", () => {
  it.each([
    ["2099-10-25 01:45", "2099-10-25 01:15"],
    ["2099-07-01 20:00", "2099-07-01 20:00"],
  ])("defers wall order only for update (%s -> %s)", (starts_at, ends_at) => {
    const fields = { ...FIELDS, starts_at, ends_at };
    expect(validateFields(fields)).toMatchObject({
      ok: false,
      errors: { ends_at: expect.any(Array) },
    });
    expect(validateFields(fields, "create")).toMatchObject({
      ok: false,
      errors: { ends_at: expect.any(Array) },
    });
    // This validates shape only: dispatch must still compare effective instants.
    expect(validateFields(fields, "update")).toMatchObject({ ok: true });
  });

  it.each([
    { starts_at: "2099-02-30 01:45" },
    { starts_at: "2030-03-31 01:30" },
    { timezone: "Not/AZone" },
    { title: "Title\u0000" },
    { capacity: 0 },
  ])("retains non-order validation on update: %j", (invalid) => {
    expect(validateFields({ ...FIELDS, ...invalid }, "update")).toMatchObject({ ok: false });
  });
});
