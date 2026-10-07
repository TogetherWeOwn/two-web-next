// The Discord events cache is module state that outlives a request, so a read cached by one
// test would answer the next test's mocked `fetch`. Reset it before every case.
import { beforeEach } from "vitest";
import { resetDiscordEventsCache } from "../src/events/discord-transients";

beforeEach(() => resetDiscordEventsCache());
