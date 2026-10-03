// Direct per-row admission contract for Discord scheduled-event rows.
// Pure unit: no DB, no network. Indirect route-level coverage lives in
// test/discord-transient-shape.test.ts; this file pins admitScheduledEvent
// itself: non-object rows, empty ids, non-string optionals, malformed
// entity_metadata, and numeric vs missing status.
import { describe, expect, it } from "vitest";
import { admitScheduledEvent } from "../src/events/discord-transient-shape";

function healthy(over: Record<string, unknown> = {}) {
  return {
    id: "1545955994972987422",
    name: "Healthy raid",
    description: "Bring a squad",
    scheduled_start_time: "2030-01-02T20:00:00Z",
    scheduled_end_time: "2030-01-02T21:00:00Z",
    status: 1,
    entity_metadata: { location: "Lobby" },
    ...over,
  };
}

describe("admitScheduledEvent", () => {
  it("admits a healthy control intact", () => {
    expect(admitScheduledEvent(healthy())).toEqual({
      id: "1545955994972987422",
      name: "Healthy raid",
      description: "Bring a squad",
      scheduled_start_time: "2030-01-02T20:00:00Z",
      scheduled_end_time: "2030-01-02T21:00:00Z",
      status: 1,
      location: "Lobby",
    });
  });

  it.each([["null"], ["array"], ["string"], ["number"], ["boolean"]])(
    "rejects non-object rows (%s)",
    (kind) => {
      const row: Record<string, unknown> = {
        null: null,
        array: [],
        string: "bad row",
        number: 42,
        boolean: false,
      };
      expect(admitScheduledEvent(row[kind])).toBeNull();
    },
  );

  it.each([
    ["missing id", { id: undefined }],
    ["numeric id", { id: 42 }],
    ["empty id", { id: "" }],
    ["missing name", { name: undefined }],
    ["numeric name", { name: 42 }],
    ["empty name", { name: "" }],
    ["missing start", { scheduled_start_time: undefined }],
    ["numeric start", { scheduled_start_time: 42 }],
  ])("rejects bad required fields (%s)", (_label, over) => {
    expect(admitScheduledEvent(healthy(over))).toBeNull();
  });

  it.each([
    ["object description", { description: {} }],
    ["numeric description", { description: 42 }],
    ["numeric end time", { scheduled_end_time: 42 }],
    ["object end time", { scheduled_end_time: {} }],
    ["numeric location", { entity_metadata: { location: 42 } }],
    ["object location", { entity_metadata: { location: {} } }],
    ["array metadata", { entity_metadata: [] }],
    ["string metadata", { entity_metadata: "Lobby" }],
  ])("rejects non-string optionals (%s)", (_label, over) => {
    expect(admitScheduledEvent(healthy(over))).toBeNull();
  });

  it("admits null or absent optionals as null", () => {
    expect(
      admitScheduledEvent(
        healthy({
          description: null,
          scheduled_end_time: null,
          entity_metadata: null,
        }),
      ),
    ).toEqual({
      id: "1545955994972987422",
      name: "Healthy raid",
      description: null,
      scheduled_start_time: "2030-01-02T20:00:00Z",
      scheduled_end_time: null,
      status: 1,
      location: null,
    });
  });

  it("admits absent metadata and absent location as null location", () => {
    const { entity_metadata: _dropped, ...noMeta } = healthy();
    expect(admitScheduledEvent(noMeta)?.location).toBeNull();
    expect(admitScheduledEvent(healthy({ entity_metadata: {} }))?.location).toBeNull();
  });

  it("preserves numeric status and maps missing status to undefined", () => {
    expect(admitScheduledEvent(healthy({ status: 2 }))?.status).toBe(2);
    const { status: _dropped, ...noStatus } = healthy();
    expect(admitScheduledEvent(noStatus)?.status).toBeUndefined();
  });

  it("maps non-numeric status to undefined instead of rejecting the row", () => {
    const admitted = admitScheduledEvent(healthy({ status: "ACTIVE" }));
    expect(admitted?.status).toBeUndefined();
    expect(admitted?.id).toBe("1545955994972987422");
  });
});
