import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { URL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "@babel/parser";
import {
  isArrowFunctionExpression,
  isCallExpression,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isMemberExpression,
  isObjectPattern,
  isObjectProperty,
  isStringLiteral,
} from "@babel/types";
import type { CallExpression, File, Node } from "@babel/types";
import { request } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { QA_SESSION_COOKIE } from "../e2e/qa-request.mjs";
import * as stagingFixtures from "../e2e/staging/fixtures";

type Journey = {
  heading: string;
  predecessor: string;
  successor: string;
};

type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: string;
  }>;
  origins: unknown[];
};

// Both BrowserContext and APIRequestContext provide this method. The request
// context keeps this regression hermetic: it exercises Playwright's actual
// storage-state serialization and cookie jar without a staging deployment.
type StorageStateWriter = {
  storageState(options?: { path?: string }): Promise<unknown>;
};

type PersistRotatedStorageState = (
  context: StorageStateWriter,
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

const enrolledSpecs = [
  {
    file: "e2e/staging/profile.spec.ts",
    statePath: "memberStorageState",
    reason:
      "its implicit Playwright context starts from the member storage-state file for each test",
  },
  {
    file: "e2e/staging/admin.spec.ts",
    statePath: "moderatorStorageState",
    reason:
      "its implicit Playwright context starts from the moderator storage-state file for each test",
  },
] as const;

let server: Server | undefined;
let origin: string | undefined;
let scratchDir: string | undefined;
const spentPredecessors = new Set<string>();

function sessionCookie(requestCookie: string | undefined): string | undefined {
  return requestCookie
    ?.split(";")
    .map((part) => part.trim().split("=", 2))
    .find(([name]) => name === QA_SESSION_COOKIE)?.[1];
}

function storageStateFor(value: string): StorageState {
  return {
    cookies: [
      {
        name: QA_SESSION_COOKIE,
        value,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        // The real QA-login seam separately proves Secure __Host- cookies.
        // This HTTP loopback proves only storage-state handoff, not browser
        // enforcement of the Secure/__Host- cookie-prefix rules.
        secure: false,
        sameSite: "Lax",
      },
    ],
    origins: [],
  };
}

function requirePersistenceHelper(): PersistRotatedStorageState {
  const helper = Reflect.get(stagingFixtures, "persistRotatedStorageState");
  expect(
    helper,
    "e2e/staging/fixtures.ts must export persistRotatedStorageState(context, storageStatePath)",
  ).toBeTypeOf("function");
  return helper as PersistRotatedStorageState;
}

async function readStorageState(path: string): Promise<StorageState> {
  return JSON.parse(await readFile(path, "utf8")) as StorageState;
}

function writeGuestResponse(response: ServerResponse): void {
  response.setHeader(
    "Set-Cookie",
    `${QA_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`,
  );
  response.writeHead(401, { "content-type": "text/html; charset=utf-8" });
  response.end("<h1>Guest</h1>");
}

function fixtureImports(sourceFile: File): Set<string> {
  const imports = new Set<string>();
  for (const statement of sourceFile.program.body) {
    if (
      !isImportDeclaration(statement) ||
      !isStringLiteral(statement.source) ||
      statement.source.value !== "./fixtures"
    ) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      if (!isImportSpecifier(specifier)) continue;
      imports.add(specifier.local.name);
    }
  }
  return imports;
}

function nodeContains(root: Node, predicate: (node: Node) => boolean): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    if ("type" in value && typeof value.type === "string" && predicate(value as Node)) return true;
    return Object.values(value).some(visit);
  };
  return visit(root);
}

function isPersistRotatedStorageStateCall(node: Node, statePath: string): node is CallExpression {
  return (
    isCallExpression(node) &&
    isIdentifier(node.callee) &&
    node.callee.name === "persistRotatedStorageState" &&
    node.arguments.length === 2 &&
    isIdentifier(node.arguments[0]) &&
    node.arguments[0].name === "context" &&
    isIdentifier(node.arguments[1]) &&
    node.arguments[1].name === statePath
  );
}

function isPersistenceHook(node: Node, statePath: string): boolean {
  if (
    !isCallExpression(node) ||
    !isMemberExpression(node.callee) ||
    !isIdentifier(node.callee.object) ||
    node.callee.object.name !== "test" ||
    !isIdentifier(node.callee.property) ||
    node.callee.property.name !== "afterEach"
  ) {
    return false;
  }

  const callback = node.arguments[0];
  if (!callback || !isArrowFunctionExpression(callback) || !callback.async) return false;

  const contextParameter = callback.params[0];
  const receivesContext =
    contextParameter &&
    isObjectPattern(contextParameter) &&
    contextParameter.properties.some(
      (property) =>
        isObjectProperty(property) &&
        isIdentifier(property.key) &&
        property.key.name === "context" &&
        isIdentifier(property.value) &&
        property.value.name === "context",
    );
  return (
    Boolean(receivesContext) &&
    nodeContains(callback.body, (child) => isPersistRotatedStorageStateCall(child, statePath))
  );
}

function hasPersistenceHook(sourceFile: File, statePath: string): boolean {
  return nodeContains(sourceFile, (node) => isPersistenceHook(node, statePath));
}

beforeAll(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "two-staging-rotation-"));
  const localServer = createServer((incoming, response) => {
    const journey = journeys[incoming.url ?? ""];
    if (!journey) {
      response.writeHead(404).end();
      return;
    }

    const bearer = sessionCookie(incoming.headers.cookie);
    const predecessorKey = `${incoming.url}:${journey.predecessor}`;
    if (bearer === journey.predecessor) {
      if (spentPredecessors.has(predecessorKey)) {
        writeGuestResponse(response);
        return;
      }
      spentPredecessors.add(predecessorKey);
      response.setHeader(
        "Set-Cookie",
        `${QA_SESSION_COOKIE}=${journey.successor}; Path=/; HttpOnly; SameSite=Lax`,
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

    writeGuestResponse(response);
  });
  server = localServer;
  await new Promise<void>((resolve) => localServer.listen(0, "127.0.0.1", resolve));
  const address = localServer.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  const runningServer = server;
  if (runningServer?.listening) {
    await new Promise<void>((resolve, reject) =>
      runningServer.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (scratchDir) await rm(scratchDir, { force: true, recursive: true });
});

describe("rotating staging session storage", () => {
  for (const [path, journey] of Object.entries(journeys)) {
    it(`keeps the next context authenticated after ${path} rotates its bearer`, async () => {
      const statePath = join(scratchDir!, `${journey.successor}.json`);
      const staleStatePath = join(scratchDir!, `${journey.predecessor}.json`);
      const preservedStatePath = join(scratchDir!, `${journey.successor}-preserved.json`);
      await writeFile(statePath, JSON.stringify(storageStateFor(journey.predecessor)));
      await writeFile(staleStatePath, JSON.stringify(storageStateFor(journey.predecessor)));
      await writeFile(preservedStatePath, JSON.stringify(storageStateFor(journey.successor)));

      const first = await request.newContext({ baseURL: origin!, storageState: statePath });
      try {
        const firstView = await first.get(path);
        expect(firstView.status()).toBe(200);
        expect(await firstView.text()).toContain(journey.heading);

        // A separately-created context proves that the original on-disk bearer
        // is dead after the first authenticated HTML navigation.
        const stale = await request.newContext({ baseURL: origin!, storageState: staleStatePath });
        try {
          const staleView = await stale.get(path);
          expect(staleView.status()).toBe(401);
          expect(await staleView.text()).toContain("Guest");

          // A failed/guest context must not destroy the last known live state.
          await requirePersistenceHelper()(stale, preservedStatePath);
          expect(await readStorageState(preservedStatePath)).toEqual(
            storageStateFor(journey.successor),
          );
        } finally {
          await stale.dispose();
        }

        await requirePersistenceHelper()(first, statePath);
      } finally {
        await first.dispose();
      }

      const stored = await readStorageState(statePath);
      const storedSessions = stored.cookies.filter((cookie) => cookie.name === QA_SESSION_COOKIE);
      expect(storedSessions).toHaveLength(1);
      expect(storedSessions[0]).toMatchObject({
        name: QA_SESSION_COOKIE,
        value: journey.successor,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
      });
      expect(storedSessions.map((cookie) => cookie.value)).not.toContain(journey.predecessor);

      const second = await request.newContext({ baseURL: origin!, storageState: statePath });
      try {
        const secondView = await second.get(path);
        expect(secondView.status()).toBe(200);
        expect(await secondView.text()).toContain(journey.heading);
      } finally {
        await second.dispose();
      }
    });
  }

  for (const { file, statePath, reason } of enrolledSpecs) {
    it(`enrolls ${file} in the persisted rotating-session lifecycle`, async () => {
      const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
      const sourceFile = parse(source, { sourceType: "module", plugins: ["typescript"] });
      const imports = fixtureImports(sourceFile);
      const importMessage = `${file} must import persistRotatedStorageState and ${statePath} from ./fixtures`;
      expect(imports.has("persistRotatedStorageState"), importMessage).toBe(true);
      expect(imports.has(statePath), importMessage).toBe(true);
      expect(
        hasPersistenceHook(sourceFile, statePath),
        `${file} must persist its live implicit context in test.afterEach(async ({ context }) => { ` +
          `await persistRotatedStorageState(context, ${statePath}); }). This spec is enrolled because ${reason}; ` +
          "auth.spec.ts and join.spec.ts use manual or guest contexts and must not snapshot those jars globally.",
      ).toBe(true);
    });
  }
});
