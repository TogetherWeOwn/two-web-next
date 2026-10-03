// Drizzle metadata/execution observation in workerd; rows/audit are memory,
// not a PostgreSQL persistence or failed-INSERT proof. No external networking.
import { Column, eq, getTableName, is } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import { Hono } from "hono";
import { memberReadDb } from "../../src/db/member-reads";
import { events } from "../../src/db/admin-schema";
import type { Db } from "../../src/db/index";
import type { SelectedField } from "../../src/db/read-classification";
import { users } from "../../src/db/schema";
import {
  bufferedMemberText,
  keyedMemberRead,
  memberReadBoundary,
  nonSensitiveRead,
} from "../../src/member-reads";
import type { AccessEntry } from "../../src/access-log";

const viewer = "100000000000000102";
const subject = "100000000000000101";
const app = new Hono();
app.get("/:mode", async (c) => {
  const mode = c.req.param("mode");
  let executions = 0;
  const entries: AccessEntry[] = [];
  const raw = drizzle.mock();
  const session = (
    raw as unknown as {
      session: { prepareQuery: (query: unknown, fields?: SelectedField[]) => unknown };
    }
  ).session;
  session.prepareQuery = (_, fields) => ({
    setToken() {
      return this;
    },
    execute: async () => {
      executions++;
      const row: Record<string, unknown> = {};
      for (const { path, field } of fields ?? []) {
        if (!is(field, Column)) throw new Error("Unsupported fixture field");
        const value =
          field.name === "id"
            ? getTableName(field.table) === "users" && mode.startsWith("alias")
              ? viewer
              : subject
            : "workerd-private-name";
        let target = row;
        for (const part of path.slice(0, -1))
          target = (target[part] ??= {}) as Record<string, unknown>;
        target[path.at(-1)!] = value;
      }
      return fields?.length ? [row] : [{ count: "1" }];
    },
  });
  const db = memberReadDb(raw as unknown as Db);
  // Both the lazy builder and its explicitly prepared statement precede capture.
  const query = db
    .select({ id: users.id, name: users.username })
    .from(users)
    .where(eq(users.id, subject));
  const prepared = query.prepare("prebuilt_workerd");
  const count = db.$count(users, eq(users.id, subject));
  const router = new Hono();
  router.use("*", (ctx, next) =>
    memberReadBoundary(
      ctx,
      { viewer, resource: "member", action: "list", route: "fixture.existing" },
      async (entry) => {
        entries.push(entry);
        return true;
      },
      next,
    ),
  );
  router.get("/existing", async (ctx) => {
    if (mode.startsWith("prebuilt")) {
      const read = () => (mode.includes("prepared") ? prepared.execute() : query);
      await (mode.endsWith("keyed") ? keyedMemberRead(read) : read());
    } else if (mode.startsWith("alias")) {
      const other = alias(users, "other");
      await keyedMemberRead(() =>
        db
          .select({
            viewerId: users.id,
            name: other.username,
            ...(mode === "alias-owned" ? { otherId: other.id } : {}),
          })
          .from(users)
          .innerJoin(other, eq(other.id, subject))
          .where(eq(users.id, viewer)),
      );
    } else if (mode === "cte") {
      const change = db
        .$with("change")
        .as(db.update(events).set({ title: "mutated" }).returning({ id: events.id }));
      await nonSensitiveRead("events", () => db.with(change).select().from(events));
    } else if (mode === "count") {
      await count;
    }
    return bufferedMemberText(ctx, "workerd-private-name");
  });
  const response = await router.request("/existing");
  const copy = new Response(response.body, response);
  copy.headers.set("x-fixture-executions", String(executions));
  copy.headers.set("x-fixture-audit", JSON.stringify(entries));
  return copy;
});
export default app;
