import postgres from "postgres";
import { testDatabaseUrl } from "./member-data-db";

export function pruneClient(schema: string, name: string, max = 1) {
  const url = testDatabaseUrl(process.env.DATABASE_URL!);
  return postgres(url.href, {
    max,
    port: 5432,
    password: () => url.password,
    connect_timeout: 5,
    connection: { search_path: schema, application_name: name },
    onnotice: () => {},
  });
}

export async function within<T>(pending: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms while held`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Observe a real wait edge, not a sleep-based guess that the DELETE started.
export async function observeLockWait(observer: postgres.Sql, name: string, holderPid: number) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const [row] = await observer<{ waiting: boolean }[]>`select exists (
      select 1 from pg_stat_activity where application_name = ${name}
        and wait_event_type = 'Lock' and ${holderPid} = any(pg_blocking_pids(pid))
    ) as waiting`;
    if (row!.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("cleanup never reached the held row lock");
}
