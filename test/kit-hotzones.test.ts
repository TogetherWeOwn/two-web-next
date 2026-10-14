import { describe, expect, it, vi } from "vitest";
import { loadHotzoneSignalData, loadHotzonesIndexData } from "../src/kit-hotzones";
import { emptyGrid } from "../src/hotzones/aggregates";

const env = { APP_URL: "https://example.test" } as never;
const grid = () => ({ cells: emptyGrid(), total: 3, eventCount: 2 });
const headers = () => vi.fn((_headers: Record<string, string>) => {});

describe("Kit hot-zone load outage and telemetry parity", () => {
  it("index serves the grids, records the board view and answers public-cacheable", async () => {
    const db = {} as never;
    const recordBoardViewFn = vi.fn(async () => {});
    const setHeaders = headers();
    const data = await loadHotzonesIndexData({
      env,
      seasonParam: null,
      setHeaders,
      dbForFn: async () => db,
      loadJoinsGridFn: async () => grid(),
      recordBoardViewFn,
    });
    expect(data.season).toBe("all");
    expect(data.joins.total).toBe(3);
    expect(data.voice.cells).toHaveLength(7);
    expect(recordBoardViewFn).toHaveBeenCalledWith(db, {
      boardKey: "hotzones",
      scope: "overall",
      season: "all",
      resultCount: 3,
    });
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "public, max-age=300" });
  });

  it("index maps a refused aggregate read to a branded 503, never a cached 500", async () => {
    const setHeaders = headers();
    const recordBoardViewFn = vi.fn(async () => {});
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: null,
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        recordBoardViewFn,
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(recordBoardViewFn).not.toHaveBeenCalled();
    expect(setHeaders).toHaveBeenCalledTimes(1);
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("joins signal records its board view; a prior signal records without any aggregate read", async () => {
    const db = {} as never;
    const recordBoardViewFn = vi.fn(async () => {});
    const loadJoinsGridFn = vi.fn(async () => grid());
    const joins = await loadHotzoneSignalData({
      env,
      seasonParam: null,
      signalParam: "joins",
      setHeaders: headers(),
      dbForFn: async () => db,
      loadJoinsGridFn,
      recordBoardViewFn,
    });
    expect(joins).toMatchObject({ signal: "joins", total: 3, estimated: false });
    expect(recordBoardViewFn).toHaveBeenCalledWith(db, {
      boardKey: "hotzones/joins",
      scope: "overall",
      season: "all",
      resultCount: 3,
    });

    recordBoardViewFn.mockClear();
    const voice = await loadHotzoneSignalData({
      env,
      seasonParam: null,
      signalParam: "voice",
      setHeaders: headers(),
      dbForFn: async () => db,
      loadJoinsGridFn,
      recordBoardViewFn,
    });
    expect(voice).toMatchObject({ signal: "voice", estimated: true });
    expect(loadJoinsGridFn).toHaveBeenCalledTimes(1);
    expect(recordBoardViewFn).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ boardKey: "hotzones/voice", scope: "overall", season: "all" }),
    );
  });

  it("signal maps a refused aggregate read to a branded 503", async () => {
    const setHeaders = headers();
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "joins",
        setHeaders,
        dbForFn: async () => ({}) as never,
        loadJoinsGridFn: async () => {
          throw new Error("connect ECONNREFUSED");
        },
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(setHeaders).toHaveBeenCalledWith({ "cache-control": "private, no-store" });
  });

  it("rejects an unknown season before any database work", async () => {
    const dbForFn = vi.fn(async () => null);
    await expect(
      loadHotzonesIndexData({
        env,
        seasonParam: "not-a-season",
        setHeaders: headers(),
        dbForFn,
        loadJoinsGridFn: async () => grid(),
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(dbForFn).not.toHaveBeenCalled();
  });

  it("rejects an unknown signal before any database work", async () => {
    const dbForFn = vi.fn(async () => null);
    await expect(
      loadHotzoneSignalData({
        env,
        seasonParam: null,
        signalParam: "bogus",
        setHeaders: headers(),
        dbForFn,
        loadJoinsGridFn: async () => grid(),
        recordBoardViewFn: async () => {},
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(dbForFn).not.toHaveBeenCalled();
  });
});
