// Guard-denial sabotage must prove it threw the member-read denial, not any error.
// An empty catch swallows a missing throw and any unrelated failure, so the
// outer 503 can pass while the sabotage never fired.
import { expect } from "vitest";
import { MemberReadRefused } from "../../src/member-reads";

export async function assertDenialThrows(
  promise: PromiseLike<unknown>,
): Promise<MemberReadRefused> {
  let thrown: unknown;
  let rejected = false;
  try {
    await promise;
  } catch (error) {
    thrown = error;
    rejected = true;
  }
  expect(rejected, "expected member-read denial to reject, but it resolved").toBe(true);
  expect(thrown).toBeInstanceOf(MemberReadRefused);
  return thrown as MemberReadRefused;
}
