/**
 * A hand-written subset of the SARIF 2.1.0 JSON Schema (sarif-schema-2.1.0.json, OASIS), covering
 * every object `--format sarif` emits, plus a minimal validator for the keywords it uses. Kept
 * local so tests need no network and no schema library. Where GitHub code scanning is stricter
 * than the schema (every result needs a location), the subset follows GitHub and says so.
 */

export interface Schema {
  type?: "object" | "array" | "string" | "integer" | "number" | "boolean";
  required?: string[];
  properties?: Record<string, Schema>;
  /** Only the schema form (`false` is not used by the SARIF schema for these objects). */
  additionalProperties?: Schema;
  items?: Schema;
  enum?: readonly unknown[];
  minimum?: number;
  minItems?: number;
}

const message: Schema = {
  type: "object",
  required: ["text"],
  properties: { text: { type: "string" }, markdown: { type: "string" } },
};

const artifactLocation: Schema = {
  type: "object",
  properties: { uri: { type: "string" }, uriBaseId: { type: "string" } },
};

const region: Schema = {
  type: "object",
  properties: {
    startLine: { type: "integer", minimum: 1 },
    startColumn: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    endColumn: { type: "integer", minimum: 1 },
  },
};

const location: Schema = {
  type: "object",
  properties: {
    id: { type: "integer", minimum: -1 },
    physicalLocation: {
      type: "object",
      required: ["artifactLocation"],
      properties: { artifactLocation, region },
    },
    message,
  },
};

const reportingDescriptor: Schema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    shortDescription: message,
    fullDescription: message,
  },
};

const result: Schema = {
  type: "object",
  required: ["message", "ruleId", "locations"],
  properties: {
    ruleId: { type: "string" },
    ruleIndex: { type: "integer", minimum: -1 },
    level: { enum: ["none", "note", "warning", "error"] },
    message,
    // The SARIF schema allows zero locations; GitHub code scanning rejects such results.
    locations: { type: "array", minItems: 1, items: location },
    relatedLocations: { type: "array", items: location },
    partialFingerprints: { type: "object", additionalProperties: { type: "string" } },
    properties: { type: "object" },
  },
};

export const SARIF_SUBSET: Schema = {
  type: "object",
  required: ["version", "runs"],
  properties: {
    $schema: { type: "string" },
    version: { enum: ["2.1.0"] },
    runs: {
      type: "array",
      items: {
        type: "object",
        required: ["tool"],
        properties: {
          tool: {
            type: "object",
            required: ["driver"],
            properties: {
              driver: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  version: { type: "string" },
                  rules: { type: "array", items: reportingDescriptor },
                },
              },
            },
          },
          originalUriBaseIds: { type: "object", additionalProperties: artifactLocation },
          columnKind: { enum: ["utf16CodeUnits", "unicodeCodePoints"] },
          results: { type: "array", items: result },
        },
      },
    },
  },
};

/** Every violation of `schema` in `value`, as `path: problem`. Empty when it conforms. */
export function validate(value: unknown, schema: Schema, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type && !hasType(value, schema.type)) {
    return [...errors, `${path}: expected ${schema.type}`];
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${path}: ${value} < ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${path}: fewer than ${schema.minItems} items`);
    }
    if (schema.items) {
      const items = schema.items;
      value.forEach((v, i) => {
        errors.push(...validate(v, items, `${path}[${i}]`));
      });
    }
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${path}: missing ${key}`);
    }
    for (const [key, v] of Object.entries(record)) {
      const sub = schema.properties?.[key] ?? schema.additionalProperties;
      if (sub) errors.push(...validate(v, sub, `${path}.${key}`));
    }
  }
  return errors;
}

function hasType(value: unknown, type: NonNullable<Schema["type"]>): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    default:
      return typeof value === type;
  }
}
