// Test-only admission control: keep a slot until the whole fixture task settles.
export function createReceiptPool() {
  const pending = new Set<Promise<unknown>>();
  const waiters: Array<() => void> = [];
  let active = 0;

  function run<T>(work: () => Promise<T>): Promise<T> {
    const task = (async () => {
      if (active >= 2) await new Promise<void>((resolve) => waiters.push(resolve));
      else active++;
      try {
        return await work();
      } finally {
        const next = waiters.shift();
        if (next) next();
        else active--;
      }
    })();
    pending.add(task);
    void task.then(
      () => pending.delete(task),
      () => pending.delete(task),
    );
    return task;
  }

  async function drain() {
    await Promise.allSettled([...pending]);
  }

  return { run, drain };
}
