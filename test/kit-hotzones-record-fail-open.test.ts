// Fail-open board-view logging in the Kit hot-zone loads
// (src/kit-hotzones.ts): a rejected record call never blocks or breaks the
// board. Hermetic: injected stubs only, no database, no network.
import { describe, expect, it, vi } from "vitest";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import { emptyGrid } from "../src/hotzones/aggregates";

const env = { APP_URL: "https://example.test" } as never;
const grid = () => ({ cells: emptyGrid(), total: 3, eventCount: 2 });
const headers = () => vi.fn((_headers: Record<string, string>) => {});

describe("Kit hot-zone board-view fail-open", () => {
  it("the index still serves when the board-view record rejects", async () => {
    const recordBoardViewFn = vi.fn(async () => {
      throw new Error("board log locked");
    });
    const setHeaders = headers();
    const data = await loadHotzonesIndexData({
      env,
      seasonParam: null,
      setHeaders,
      dbForFn: async () => ({}) as never,
      loadJoinsGridFn: async () => grid(),
      recordBoardViewFn,
    });
    expect(data.season).toBe("all");
    expect(data.joins.total).toBe(3);
    expect(recordBoardViewFn).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "public, max-age=300" });
  });

  it("a signal still serves when the board-view record rejects", async () => {
    const recordBoardViewFn = vi.fn(async () => {
      throw new Error("board log locked");
    });
    const setHeaders = headers();
    const data = await loadHotzoneSignalData({
      env,
      seasonParam: null,
      signalParam: "joins",
      setHeaders,
      dbForFn: async () => ({}) as never,
      loadJoinsGridFn: async () => grid(),
      recordBoardViewFn,
    });
    expect(data).toMatchObject({ signal: "joins", total: 3 });
    expect(recordBoardViewFn).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "public, max-age=300" });
  });
});
