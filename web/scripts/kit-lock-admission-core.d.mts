import type { KitLockRoot } from "./kit-lock-admission.mjs";
export function createKitLockAdmission(env: object): (path: string) => KitLockRoot; // test seam
