import { isAbsolute, resolve, sep } from "node:path";

export class KitLockAdmissionError extends Error {
  constructor(message, options) {
    super(`kit lock admission: ${message}`, options);
    this.name = "KitLockAdmissionError";
  }
}

export function refuse(message, cause) {
  throw new KitLockAdmissionError(message, cause === undefined ? undefined : { cause });
}

export function guard(label, operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof KitLockAdmissionError) throw error;
    return refuse(`${label} failed`, error);
  }
}

function supportedNode(version) {
  const [major, minor] = String(version).split(".").map(Number);
  return major >= 24 || (major === 22 && minor >= 23);
}

export function checkAdmissionInput(env, path) {
  if (env.platform !== "linux") refuse("Linux is required");
  if (!supportedNode(env.nodeVersion)) refuse("Node 22.23+ on 22, or 24+, is required");
  if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) {
    refuse("an absolute normalized path is required");
  }
  if (path === sep) refuse("filesystem root is refused");
}
