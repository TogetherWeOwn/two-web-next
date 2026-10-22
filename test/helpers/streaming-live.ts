import type { Env } from "../../src/env";

// Public-page read port, specified before implementation. These are display
// facts, never an authorization/quota decision and never ingest credentials.
export type LiveDestination = {
  id: string;
  provider: "twitch" | "youtube" | "custom";
  label: string;
  watchUrl: string;
  embedUrl: string | null;
  enabled: boolean;
  live: boolean;
};

export type LiveMember = {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  bio: string;
  entitled: boolean;
  input: { uid: string; enabled: boolean; hlsUrl: string } | null;
  destinations: LiveDestination[];
  schedule: string | null;
  lastLiveAt: string | null;
};

export type LiveStatus = { live: boolean; sessionId: string | null };

export type StreamingLiveReads = {
  now: () => number;
  globalEnabled: () => Promise<boolean>;
  readMember: (userId: string) => Promise<LiveMember | null>;
  readStatus: (inputUid: string) => Promise<LiveStatus>;
};

export const STREAM_USER = "01K00000000000000000000001";
export const LIVE_PATH = `/members/${STREAM_USER}/live`;
export const LINKS_PATH = `/members/${STREAM_USER}/links`;
export const STREAM_ORIGIN = "https://next.example.test";
export const TWITCH: LiveDestination = {
  id: "twitch-destination",
  provider: "twitch",
  label: "Casey on Twitch",
  watchUrl: "https://www.twitch.tv/casey_example",
  embedUrl: "https://player.twitch.tv/?channel=casey_example",
  enabled: true,
  live: true,
};
export const YOUTUBE: LiveDestination = {
  id: "youtube-destination",
  provider: "youtube",
  label: "Casey on YouTube",
  watchUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  embedUrl: "https://www.youtube-nocookie.com/embed/abcdefghijk",
  enabled: true,
  live: true,
};

let sequence = 0;

export function streamingLiveFixture() {
  let time = Date.UTC(2026, 9, 21, 12);
  let enabled = true;
  let status: LiveStatus = { live: true, sessionId: "broadcast-a" };
  let readFailure = false;
  let member: LiveMember | null = {
    userId: STREAM_USER,
    displayName: "Casey Example",
    avatarUrl: null,
    bio: "Community games and creative streams",
    entitled: true,
    input: {
      uid: (++sequence).toString(16).padStart(32, "0"),
      enabled: true,
      hlsUrl:
        "https://customer-example.cloudflarestream.com/11111111111111111111111111111111/manifest/video.m3u8",
    },
    destinations: [{ ...TWITCH }],
    schedule: "Fridays at 18:00 UTC",
    lastLiveAt: "2026-10-20T18:00:00.000Z",
  };
  const statusCalls: string[] = [];
  const memberCalls: string[] = [];
  const reads: StreamingLiveReads = {
    now: () => time,
    globalEnabled: async () => enabled,
    readMember: async (userId) => {
      memberCalls.push(userId);
      return userId === STREAM_USER ? member : null;
    },
    readStatus: async (uid) => {
      statusCalls.push(uid);
      if (readFailure) throw new Error("synthetic live-status outage");
      return { ...status };
    },
  };
  const env: Env & { STREAMING_LIVE: StreamingLiveReads } = {
    APP_URL: STREAM_ORIGIN,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/configured",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    STREAMING_LIVE: reads,
  };
  return {
    env,
    reads,
    statusCalls,
    memberCalls,
    get member() {
      if (!member) throw new Error("Fixture member has been removed");
      return member;
    },
    removeMember: () => {
      member = null;
    },
    at: (milliseconds: number) => {
      time = Date.UTC(2026, 9, 21, 12) + milliseconds;
    },
    status: (next: LiveStatus) => {
      status = next;
    },
    globalEnabled: (next: boolean) => {
      enabled = next;
    },
    failStatus: (next: boolean) => {
      readFailure = next;
    },
  };
}
