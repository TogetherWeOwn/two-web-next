// Minimal JSON-Schema conformance checker for the bounded public read API.
// Covers exactly what src/public-data/openapi.ts emits: type (or a list of
// types, OpenAPI 3.1 style), required, properties, items and enum. Formats
// are intentionally unchecked: the shape, not the clock, is the contract.
import { getOpenApiDocument } from "../../src/public-data/openapi";

type Schema = {
  type?: string | string[];
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  enum?: unknown[];
};

export function validatePublicSchema(value: unknown, name: string): string[] {
  const schemas = getOpenApiDocument("https://next.example.test").components.schemas as Record<
    string,
    Schema
  >;
  const schema = schemas[name];
  if (!schema) return [`unknown schema ${name}`];
  return check(value, schema, "$");
}

function check(value: unknown, schema: Schema, path: string): string[] {
  const problems: string[] = [];
  if (schema.enum) {
    if (!schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value)))
      problems.push(`${path} not in enum`);
    return problems;
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (types.length > 0 && !types.some((type) => matches(value, type))) {
    problems.push(`${path} is not ${types.join("|")}`);
    return problems;
  }
  if ((types.includes("object") || (!schema.type && schema.properties)) && isRecord(value)) {
    for (const name of schema.required ?? []) {
      if (!(name in value)) problems.push(`${path}.${name} is missing`);
    }
    for (const [name, property] of Object.entries(schema.properties ?? {})) {
      if (name in value) problems.push(...check(value[name], property, `${path}.${name}`));
    }
  }
  if (types.includes("array") && Array.isArray(value) && schema.items) {
    value.forEach((item, index) =>
      problems.push(...check(item, schema.items!, `${path}[${index}]`)),
    );
  }
  return problems;
}

function matches(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
