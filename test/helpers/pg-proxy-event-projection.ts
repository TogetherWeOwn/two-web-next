// Positional pg-proxy projection for explicit `events` selects.
//
// Drizzle's pg-proxy maps each returned row array to the selected fields by
// position, so a fixture that answers with full stored rows misaligns as
// soon as a read selects an explicit subset. This models the two item shapes
// the egress reads emit: a plain column, and a byte-admitted column
// (`case when octet_length(col) <= $n then col end`, NULL over budget).
// Anything else throws, so a new computed projection fails loudly instead of
// feeding the read shifted values.
import { getTableColumns } from "drizzle-orm";
import { events } from "../../src/db/admin-schema";

const propertyByDbName = new Map(
  Object.entries(getTableColumns(events)).map(([property, column]) => [column.name, property]),
);
const utf8 = new TextEncoder();
const PLAIN = /^(?:"events"\.)?"([a-z_]+)"$/;
const ADMITTED =
  /^case when octet_length\((?:"events"\.)?"([a-z_]+)"\) <= \$(\d+) then (?:"events"\.)?"([a-z_]+)" end$/;

/** True when `sql` selects an explicit projection rather than every column. */
export const isEventProjection = (sql: string) => sql.includes("octet_length(");

/**
 * Encode one stored row as the value array PostgreSQL would return for `sql`
 * with its bound `params`. `encodeValue` keeps the fixture's own scalar
 * convention (for example how a stored Date is spelled).
 */
export function projectEventRow(
  sql: string,
  params: readonly unknown[],
  row: object,
  encodeValue: (value: unknown) => unknown,
): unknown[] {
  const source = row as Record<string, unknown>;
  const valueOf = (dbName: string) => {
    const property = propertyByDbName.get(dbName);
    if (!property) throw new Error(`Unknown events column in projection: ${dbName}`);
    return source[property];
  };
  const list = sql.slice("select ".length, sql.search(/ from "events"/));
  return list.split(", ").map((item) => {
    const plain = PLAIN.exec(item);
    if (plain) return encodeValue(valueOf(plain[1]!));
    const admitted = ADMITTED.exec(item);
    if (admitted && admitted[1] === admitted[3]) {
      const value = valueOf(admitted[1]!);
      const budget = Number(params[Number(admitted[2]) - 1]);
      return utf8.encode(String(value ?? "")).length <= budget ? encodeValue(value) : null;
    }
    throw new Error(`Unexpected pg-proxy events projection item: ${item}`);
  });
}
