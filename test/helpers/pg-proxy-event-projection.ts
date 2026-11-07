// Positional pg-proxy projection for explicit `events` selects.
//
// Drizzle's pg-proxy maps each returned row array to the selected fields by
// position, so a fixture that answers with full stored rows misaligns as
// soon as a read selects an explicit subset. This models the three item shapes
// the egress reads emit: a plain column, a byte-admitted column
// (`case when octet_length(col) <= $n then col end`, NULL over budget), and
// the feed's whole-row fit marker.
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
// The feed's whole-row marker: `(octet_length(a) > $1 or ...) is not true`.
const FITS = /^\((.+)\) is not true$/;
const OVER = /^octet_length\((?:"events"\.)?"([a-z_]+)"\) > \$(\d+)$/;

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
    // An absent fixture property is a NULL column, as PostgreSQL returns it.
    return source[property] ?? null;
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
    const fits = FITS.exec(item);
    if (fits) {
      return fits[1]!.split(" or ").every((term) => {
        const over = OVER.exec(term);
        if (!over) throw new Error(`Unexpected pg-proxy events fit term: ${term}`);
        const budget = Number(params[Number(over[2]) - 1]);
        return utf8.encode(String(valueOf(over[1]!) ?? "")).length <= budget;
      });
    }
    throw new Error(`Unexpected pg-proxy events projection item: ${item}`);
  });
}

const allColumns = Object.keys(getTableColumns(events));

/** `projectEventRow` for an explicit projection, every column in order otherwise. */
export function encodeEventRow(
  sql: string,
  params: readonly unknown[],
  row: object,
  encodeValue: (value: unknown) => unknown,
): unknown[] {
  if (isEventProjection(sql)) return projectEventRow(sql, params, row, encodeValue);
  const source = row as Record<string, unknown>;
  return allColumns.map((column) => encodeValue(source[column]));
}
