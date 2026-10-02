// Local workerd contract fixture. No external network, role store or DB seam.
import { Hono } from "hono";
import { bufferedMemberText, memberReadBoundary } from "../../src/member-reads";
import type { AccessDecl, AccessEntry } from "../../src/access-log";

const app = new Hono<{ Variables: { access: AccessDecl } }>();
let pulls = 0;
const entries: AccessEntry[] = [];
app.use("/reads/*", (c, next) =>
  memberReadBoundary(
    c,
    {
      viewer: "100000000000000102",
      resource: "member",
      action: "list",
      route: "test.workerd.members",
    },
    async (entry) => {
      entries.push(entry);
      return true;
    },
    next,
  ),
);
app.get("/reads/buffered", (c) => bufferedMemberText(c, "known buffered bytes"));
app.get("/reads/ordinary", () => new Response("unclassified sensitive token"));
app.get("/reads/:mode", (c) => {
  if (c.req.param("mode") === "declared") {
    c.set("access", {
      resource: "member",
      action: "list",
      route: "test.workerd.members",
      subjects: ["100000000000000101"],
    });
    bufferedMemberText(c, "previous buffer cannot authorize a replacement");
  }
  c.res = new Response(
    new ReadableStream(
      {
        pull(controller) {
          pulls++;
          controller.enqueue(new TextEncoder().encode("stream-sensitive-token"));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  );
  return c.res;
});
app.get("/state", (c) => c.json({ pulls, entries: entries.length }));
export default app;
