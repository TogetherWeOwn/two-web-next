import { expect, it, vi } from "vitest";
import type { AttendancePayload, AttendanceReader } from "../src/bot/attendance-read";
import { readEventDetailEcho } from "../src/events/event-detail-echo";
import contract from "./fixtures/bot-site-contract-v2.json";

const { request, results } = contract.verbs["event.attendance.read"];
const attendance: AttendancePayload = { ...results.read, v: 1 };
const event = {
  id: 7,
  eventKey: request.event_key,
  status: "past" as const,
  endsAt: new Date("2026-11-07T21:00:00Z"),
};
const observedAt = Date.parse("2026-11-07T21:41:00Z");

it("projects only the two frozen counts and the observation's event and time", async () => {
  const read = vi.fn<AttendanceReader>().mockResolvedValue({ ok: true, attendance });
  const expected = {
    eventKey: event.eventKey,
    at: observedAt,
    attendance: { attendedCount: 2, peakConcurrent: 5 },
  };
  expect(await readEventDetailEcho(event, read, observedAt)).toStrictEqual(expected);
  expect(await readEventDetailEcho(event, read, observedAt)).toStrictEqual(expected);
  expect(read.mock.calls).toStrictEqual([[event.eventKey], [event.eventKey]]);
});

it("does not read draft, cancelled or unended events or use an invalid observation time", async () => {
  const read = vi.fn<AttendanceReader>();
  expect(
    await readEventDetailEcho({ ...event, status: "draft" }, read, observedAt),
  ).toBeUndefined();
  expect(
    await readEventDetailEcho({ ...event, status: "cancelled" }, read, observedAt),
  ).toBeUndefined();
  expect(
    await readEventDetailEcho({ ...event, status: "published" }, read, event.endsAt.getTime() - 1),
  ).toBeUndefined();
  expect(await readEventDetailEcho(event, read, NaN)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
});

it("omits an Echo before the producer window closes or for a different event key", async () => {
  const read = vi.fn<AttendanceReader>().mockResolvedValue({ ok: true, attendance });
  expect(
    await readEventDetailEcho(event, read, Date.parse(attendance.window.ends_at) - 1),
  ).toBeUndefined();
  expect(
    await readEventDetailEcho({ ...event, eventKey: "other-event" }, read, observedAt),
  ).toBeUndefined();
});

it("keeps the exact window close in counting and accepts a final reply just after it", async () => {
  const read = vi.fn<AttendanceReader>().mockResolvedValue({ ok: true, attendance });
  const windowEnd = Date.parse(attendance.window.ends_at);
  expect(await readEventDetailEcho(event, read, windowEnd)).toBeUndefined();
  expect(await readEventDetailEcho(event, read, windowEnd + 1)).toMatchObject({
    at: windowEnd + 1,
    attendance: { attendedCount: 2, peakConcurrent: 5 },
  });
});
