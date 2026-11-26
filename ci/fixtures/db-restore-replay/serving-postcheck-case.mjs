import assert from "node:assert/strict";
import { withClient } from "./cluster.mjs";

export async function assertServingPostcheckRollback({
  admin,
  login,
  isolate,
  forward,
  readAclState,
  probeBefore,
  retryForward,
}) {
  const before = await readAclState();
  await withClient(admin(), (sql) => sql`grant create on schema public to ${sql(login)}`);
  try {
    const withFault = await readAclState();
    assert.notDeepEqual(withFault, before);
    // The forward plan omits public schema ACLs. This extra authority is
    // checked only after the replacement grants and revokes have run.
    await assert.rejects(isolate("forward", forward), {
      code: "ERR_ASSERTION",
      message: "Unexpected serving role authority",
    });
    assert.equal(await isolate("readback"), "before");
    assert.deepEqual(await readAclState(), withFault);
  } finally {
    await withClient(admin(), (sql) => sql`revoke create on schema public from ${sql(login)}`);
  }

  assert.deepEqual(await readAclState(), before);
  await probeBefore();
  await retryForward();
  assert.equal(await isolate("readback"), "after");
}
