import { createHash, createHmac, randomBytes } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { signedAttendanceReader } from "../src/bot/attendance-read";
import { projectPublicEcho } from "../src/events/echo-public";
import { buildFrozenEcho } from "../src/events/echoes";
import contract from "./fixtures/bot-site-contract-v2.json";

const { request, results } = contract.verbs["event.attendance.read"];
const event = { id: 7, eventKey: request.event_key, status: "past" };
const attendance = {
  ...results.read,
  members: [
    ...results.read.members,
    { discord_id: "100000000000000003", minutes: 9, sessions: 1, first_joined_at: null },
  ],
};

afterEach(() => vi.restoreAllMocks());

async function projectObservation(response: Response) {
  const secret = randomBytes(32).toString("hex");
  const keyId = "echo-fixture";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
  const read = signedAttendanceReader(
    { baseUrl: "https://bot.example.test", keyId, secret },
    fetcher,
  );
  vi.spyOn(Date, "now").mockReturnValue(1_794_087_000_123);
  const result = await read(event.eventKey);

  // Assert outside the reader so a signing regression cannot pass a refusal case.
  const body = JSON.stringify(request);
  expect(fetcher).toHaveBeenCalledExactlyOnceWith(
    "https://bot.example.test/internal/actions",
    expect.objectContaining({ method: "POST", body, redirect: "manual" }),
  );
  const headers = new Headers(fetcher.mock.calls[0]?.[1]?.headers);
  const timestamp = headers.get("X-TWO-Timestamp");
  const nonce = headers.get("X-TWO-Nonce");
  expect(timestamp).toBe("1794087000");
  expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  const digest = createHash("sha256").update(body).digest("hex");
  const signed = ["POST", "/internal/actions", timestamp, nonce, digest].join("\n");
  const signature = createHmac("sha256", secret).update(signed).digest("hex");
  expect(headers.get("X-TWO-Key-Id")).toBe(keyId);
  expect(headers.get("X-TWO-Signature")).toBe(`sha256=${signature}`);
  expect(headers.has("Idempotency-Key")).toBe(false);

  const snapshot = buildFrozenEcho(event, result);
  if (!snapshot) return { result, publicEcho: null };
  const internalEcho = { ...snapshot.echo, members: snapshot.members, headline: null };
  return { result, publicEcho: projectPublicEcho(internalEcho) };
}

it("publishes only frozen attendance counts and room names from a finalized Bot observation", async () => {
  const response = Response.json({ ok: true, result: attendance });
  const { publicEcho } = await projectObservation(response);
  expect(publicEcho).toStrictEqual({
    eventId: 7,
    eventKey: "test-raid-night-1",
    label: "attendance record",
    headline: null,
    attendedCount: 2,
    peakConcurrent: 5,
    rooms: [{ name: "Raid 1" }],
    windowEndsAt: "2026-11-07T21:15:00.000Z",
    thresholdMinutes: 10,
  });
});

it("publishes no Echo for a provisional observation even with populated member and room rows", async () => {
  const response = Response.json({ ok: true, result: { ...attendance, final: false } });
  const { result, publicEcho } = await projectObservation(response);
  expect(result).toMatchObject({ ok: true, attendance: { final: false } });
  expect(publicEcho).toBeNull();
});

it("publishes no Echo when the Bot suppresses the record", async () => {
  // two-bot-next#2407 shows that suppression of the only member yields NotFound.
  const response = Response.json(
    { ok: false, error: { code: results.not_found.outcome, message: "Not found" } },
    { status: 404 },
  );
  const { result, publicEcho } = await projectObservation(response);
  expect(result).toStrictEqual({ ok: false, code: "not_found" });
  expect(publicEcho).toBeNull();
});
