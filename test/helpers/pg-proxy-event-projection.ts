// Positional pg-proxy projection for events reads.
//
// Drizzle's pg-proxy maps each returned row array to the selected fields by
// position, so a fixture that answers with full stored rows silently
// misaligns as soon as a read selects an explicit subset. This helper
// models the emitted SELECT instead: plain columns pass through, the
// egress byte-admission CASE returns NULL over its bound budget, the
// refusal-marker CASE aggregates those checks to 1/0, and the series
// context's combined byte budget (`case when (sum) <= $n then "col" end`
// plus its boolean marker) evaluates the same sum. Anything else throws,
// so a new computed projection fails the fixture loudly rather than
// feeding the read shifted values.
import { getTableColumns } from "drizzle-orm";
import { events } from "../../src/db/admin-schema";

const propertyByDbName = new Map(
  Object.entries(getTableColumns(events)).map(([property, column]) => [column.name, property]),
);
const textEncoder = new TextEncoder();
const itemsBySql = new Map<string, string[]>();

const defaultEncode = (value: unknown): unknown =>
  value instanceof Date
    ? Number.isFinite(value.getTime())
      ? value.toISOString()
      : "infinity"
    : value;

function selectItems(sql: string): string[] {
  const cached = itemsBySql.get(sql);
  if (cached) return cached;
  const start = sql.indexOf("select ") + "select ".length;
  const end = sql.search(/\sfrom\s+"events"/i);
  const list = sql.slice(start, end);
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (quoted) {
      current += ch;
      if (ch === "'") {
        if (list[i + 1] === "'") {
          current += "'";
          i++;
        } else quoted = false;
      }
      continue;
    }
    if (ch === "'") quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) items.push(current.trim());
  itemsBySql.set(sql, items);
  return items;
}

/**
 * Encode one stored event row as the positional value array PostgreSQL
 * would return for `sql` (with its bound `params`). `encodeValue` keeps a
 * fixture's own scalar convention (for example how a non-finite stored
 * timestamp is spelled); it never sees the byte-admission decision.
 */
export function projectEventRowValues(
  sql: string,
  params: readonly unknown[],
  row: object,
  encodeValue: (value: unknown) => unknown = defaultEncode,
): unknown[] {
  const source = row as Record<string, unknown>;
  const valueOf = (dbName: string) => source[propertyByDbName.get(dbName)!];
  const byteLength = (dbName: string) => textEncoder.encode(String(valueOf(dbName) ?? "")).length;
  // Sum of every octet_length term in a combined-budget condition; null when
  // SQL would yield NULL (a non-coalesced term over a stored NULL).
  const octetSum = (condition: string): number | null => {
    let sum = 0;
    for (const match of condition.matchAll(
      /(coalesce\()?octet_length\((?:"events"\.)?"([^"]+)"\)/g,
    )) {
      const value = valueOf(match[2]!);
      if (value === null || value === undefined) {
        if (!match[1]) return null;
        continue;
      }
      sum += textEncoder.encode(String(value)).length;
    }
    return sum;
  };
  const overBudget = (condition: string) =>
    [...condition.matchAll(/octet_length\("events"\."([^"]+)"\), 0\) > \$(\d+)/g)].some(
      (match) => byteLength(match[1]!) > Number(params[Number(match[2]) - 1]),
    );

  return selectItems(sql).map((item) => {
    if (/then 1 else 0 end/i.test(item)) return overBudget(item) ? 1 : 0;
    const admitted = /else\s+(?:"events"\.)?"([^"]+)"\s+end/i.exec(item)?.[1];
    if (admitted) return overBudget(item) ? null : encodeValue(valueOf(admitted));
    const combined = /^case when ([\s\S]+) <= \$(\d+) then (?:"events"\.)?"([^"]+)" end$/i.exec(
      item,
    );
    if (combined) {
      const sum = octetSum(combined[1]!);
      return sum !== null && sum <= Number(params[Number(combined[2]) - 1])
        ? encodeValue(valueOf(combined[3]!))
        : null;
    }
    const fitsMarker = /^\(([\s\S]+)\) <= \$(\d+)$/i.exec(item);
    if (fitsMarker && item.includes("octet_length")) {
      const sum = octetSum(fitsMarker[1]!);
      return sum !== null && sum <= Number(params[Number(fitsMarker[2]) - 1]);
    }
    const plain = /^(?:"events"\.)?"([^"]+)"$/.exec(item)?.[1];
    if (plain) return encodeValue(valueOf(plain));
    throw new Error("Unexpected pg-proxy event projection item");
  });
}
