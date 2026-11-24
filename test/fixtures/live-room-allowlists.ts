const rooms = Array.from({ length: 100 }, (_, i) =>
  String(10_000_000_000_000_000_000n + BigInt(i)),
);

export const roomAllowlistCases = [
  ["missing", undefined, null],
  ["empty", "", null],
  ["malformed", "10, 11", null],
  ["duplicate", "10,10", null],
  ["out of range", "18446744073709551616", null],
  ["oversized", "1".repeat(2_100), null],
  ["at the 100-room and 2099-byte boundary", rooms.join(","), 100],
  [
    "over 100 rooms under the byte limit",
    Array.from({ length: 101 }, (_, i) => i + 1).join(","),
    null,
  ],
] as const;
