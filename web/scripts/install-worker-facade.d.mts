export const ENTRY_NAME: string;
export const COMPANION_NAME: string;
export const FACADE_MARKER: string;
export const DEFAULT_DIR: string;
export type InstallerIo = {
  writeFileSync: typeof import("node:fs").writeFileSync;
  renameSync: typeof import("node:fs").renameSync;
  openSync: typeof import("node:fs").openSync;
  closeSync: typeof import("node:fs").closeSync;
  undo: Partial<Pick<typeof import("node:fs"), "writeFileSync" | "renameSync" | "rmSync">>;
};
export function installWorkerFacade(options?: {
  dir?: string;
  io?: Partial<InstallerIo>;
}): Promise<{ adapterSha256: string; facadeSha256: string; companion: string }>;
