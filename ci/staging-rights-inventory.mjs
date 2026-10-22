// Offline preparation only. No arguments, environment, imports or live adapter.
export function inventoryStatus() {
  return "inventory stopped";
}

if (import.meta.main) {
  process.stdout.write(`${inventoryStatus()}\n`);
  process.exitCode = 1;
}
