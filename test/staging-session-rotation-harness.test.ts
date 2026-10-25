import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { request, type APIRequestContext } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as stagingFixtures from "../e2e/staging/fixtures";

type Journey = {
  heading: string;
  predecessor: string;
  successor: string;
};

type PersistRotatedStorageState = (
  context: Pick<APIRequestContext, "storageState">,
  storageStatePath: string,
) => Promise<void>;

const journeys: Record<string, Journey> = {
  "/profile": {
    heading: "QA Member",
    predecessor: "member-predecessor",
    successor: "member-successor",
  },
  "/admin": {
    heading: "QA Moderator",
    predecessor: "moderator-predecessor",
    successor: "moderator-successor",
  },
};

let server: Server;
let origin: string;
let scratchDir: string;

function sessionCookie(requestCookie: string | undefined): string | undefined {
  return requestCookie
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === "staging-session")?.[1];
}

function requirePersistenceHelper(): PersistRotatedStorageState {
  const helper = Reflect.get(stagingFixtures, "persistRotatedStorageState");
  expect(helper).toBeTypeOf("function");
  return helper as PersistRotatedStorageState;
}

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "two-staging-rotation-"));
  server = createServer((incoming, response) => {
    const journey = journeys[incoming.url ?? ""];
    if (!journey) {
      response.writeHead(404).end();
      return;
    }

    const bearer = sessionCookie(incoming.headers.cookie);
    if (bearer === journey.predecessor) {
      response.setHeader(
        "Set-Cookie",
        `staging-session=${journey.successor}; Path=/; HttpOnly; SameSite=Lax`,
      );
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<h1>${journey.heading}</h1>`);
      return;
    }
    if (bearer === journey.successor) {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(`<h1>${journey.heading}</h1>`);
      return;
    }

    response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
    response.end("<h1>Guest</h1>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(scratchDir, { force: true, recursive: true });
});

describe("rotating staging session storage", () => {
  it.each(Object.entries(journeys))(
    "keeps the next context authenticated after %s rotates its bearer",
    async (path, journey) => {
      const statePath = join(scratchDir, `${journey.successor}.json`);
      await writeFile(
        statePath,
        JSON.stringify({
          cookies: [
            {
              name: "staging-session",
              value: journey.predecessor,
              domain: "127.0.0.1",
              path: "/",
              expires: -1,
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
            },
          ],
          origins: [],
        }),
      );

      const first = await request.newContext({ baseURL: origin, storageState: statePath });
      try {
        const firstView = await first.get(path);
        expect(firstView.status()).toBe(200);
        await expect(firstView.text()).resolves.toContain(journey.heading);
        await requirePersistenceHelper()(first, statePath);
      } finally {
        await first.dispose();
      }

      const stored = JSON.parse(await readFile(statePath, "utf8")) as {
        cookies: Array<{ name: string; value: string }>;
      };
      expect(stored.cookies).toContainEqual(
        expect.objectContaining({
          name: "staging-session",
          value: journey.successor,
        }),
      );

      const second = await request.newContext({ baseURL: origin, storageState: statePath });
      try {
        const secondView = await second.get(path);
        expect(secondView.status()).toBe(200);
        await expect(secondView.text()).resolves.toContain(journey.heading);
      } finally {
        await second.dispose();
      }
    },
  );

  it.each([
    ["e2e/staging/profile.spec.ts", "memberStorageState"],
    ["e2e/staging/admin.spec.ts", "moderatorStorageState"],
  ])("enrolls %s in the persisted rotating-session lifecycle", async (file, statePath) => {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    expect(source).toMatch(
      new RegExp(
        `test\\.afterEach\\([\\s\\S]*?persistRotatedStorageState\\(context,\\s*${statePath}\\)`,
      ),
    );
  });
});
