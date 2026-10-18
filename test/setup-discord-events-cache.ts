// Route fixtures share test-owned completed bytes only. Production never uses this store.
import { beforeEach, vi } from "vitest";
import { memoryDiscordBacking, memoryDiscordStore } from "./helpers/discord-snapshot-store";

let backing = memoryDiscordBacking();
vi.mock("../src/events/discord-snapshot-postgres", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/events/discord-snapshot-postgres")>()),
  postgresDiscordSnapshotStore: () => memoryDiscordStore(backing),
}));
beforeEach(() => {
  backing = memoryDiscordBacking();
});
