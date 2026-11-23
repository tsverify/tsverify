import type { z } from "zod";
import { type FindingCollector, list, suggest } from "./findings";
import type { Locator, Path } from "./positions";
import { specSchema } from "./schema";

type Issue = z.core.$ZodIssue;

interface Leaf {
  issue: Issue;
  /** Absolute path (union branches report paths relative to the union). */
  path: Path;
}

/** Turns zod issues into actionable `invalid-spec` findings at the most specific YAML node. */
export function reportSchemaIssues(
  issues: readonly Issue[],
  raw: unknown,
  locator: Locator,
  out: FindingCollector,
): void {
  const leaves = flatten(issues, []);
  // A misspelt required key is reported once, as the unknown key, not also as a missing one.
  const misspelt = new Set<string>();
  for (const { issue, path } of leaves) {
    if (issue.code !== "unrecognized_keys") continue;
    const allowed = keysAt(path);
    for (const key of issue.keys) {
      const guess = suggest(key, allowed);
      if (guess) misspelt.add(JSON.stringify([...path, guess]));
    }
  }
  for (const { issue, path } of leaves) {
    if (isMissing(issue) && misspelt.has(JSON.stringify(path))) continue;
    report(issue, path, raw, locator, out);
  }
}

function isMissing(issue: Issue): boolean {
  return issue.code === "invalid_type" && issue.input === undefined;
}

function report(
  issue: Issue,
  path: Path,
  raw: unknown,
  locator: Locator,
  out: FindingCollector,
): void {
  if (issue.code === "unrecognized_keys") {
    const { ctx, rest, transition } = context(path, raw);
    const allowed = keysAt(path);
    for (const key of issue.keys) {
      const guess = suggest(key, allowed);
      const where = rest.length > 0 ? ` in "${field(rest)}"` : "";
      const tail = guess ? `did you mean "${guess}"?` : `allowed: ${list(allowed)}`;
      out.error(locator.key([...path, key]), `${ctx}: unknown key "${key}"${where} (${tail})`, {
        transition,
      });
    }
    return;
  }

  if (isMissing(issue) && path.length > 0) {
    const { ctx, rest, transition } = context(path.slice(0, -1), raw);
    const key = field([...rest, path[path.length - 1] as string | number]);
    out.error(locator.value(path), `${ctx}: missing required key "${key}"`, { transition });
    return;
  }

  const { ctx, rest, transition } = context(path, raw);
  const subject = rest.length > 0 ? `"${field(rest)}" ` : "";
  const got = ` (got ${describeValue(issue.input)})`;
  let problem: string;
  let hint: string | undefined;
  switch (issue.code) {
    case "invalid_type":
      problem = `must be ${expected(issue.expected)}${got}`;
      break;
    case "invalid_union":
      problem = `must be ${unionExpected(issue)}${got}`;
      break;
    case "invalid_value": {
      problem =
        issue.values.length === 1
          ? `must be ${JSON.stringify(issue.values[0])}${got}`
          : `must be one of ${issue.values.map(String).join(", ")}${got}`;
      const guess =
        typeof issue.input === "string"
          ? suggest(issue.input, issue.values.map(String))
          : undefined;
      if (guess !== undefined) hint = `did you mean "${guess}"?`;
      break;
    }
    case "too_small":
      problem =
        issue.origin === "array" || issue.origin === "string"
          ? "must not be empty"
          : issue.minimum === 1
            ? `must be a positive integer${got}`
            : `must be at least ${issue.minimum}${got}`;
      break;
    case "invalid_format":
      problem = `${issue.message}${got}`;
      break;
    default:
      problem = issue.message;
  }
  out.error(locator.value(path), `${ctx}: ${subject}${problem}`, {
    transition,
    ...(hint !== undefined && { hint }),
  });
}

/** Replaces each `invalid_union` with the issues of the branch that got furthest, when one did. */
function flatten(issues: readonly Issue[], prefix: Path): Leaf[] {
  const leaves: Leaf[] = [];
  for (const issue of issues) {
    const path = [...prefix, ...(issue.path as (string | number)[])];
    if (issue.code === "invalid_union") {
      const branch = bestBranch(issue.errors);
      if (branch) {
        leaves.push(...flatten(branch, path));
        continue;
      }
    }
    leaves.push({ issue, path });
  }
  return leaves;
}

/** A branch that only failed with a type mismatch at its root did not get anywhere. */
function bestBranch(branches: readonly (readonly Issue[])[]): readonly Issue[] | undefined {
  let best: readonly Issue[] | undefined;
  let bestScore = 0;
  for (const branch of branches) {
    let score = 0;
    for (const issue of branch) {
      const rootMismatch = issue.code === "invalid_type" && issue.path.length === 0;
      score = Math.max(score, rootMismatch ? 0 : 1 + issue.path.length);
    }
    if (score > bestScore) {
      best = branch;
      bestScore = score;
    }
  }
  return best;
}

function unionExpected(issue: Extract<Issue, { code: "invalid_union" }>): string {
  const kinds = new Set<string>();
  for (const branch of issue.errors) {
    for (const i of branch) if (i.code === "invalid_type") kinds.add(expected(i.expected));
  }
  return kinds.size > 0 ? [...kinds].join(" or ") : "valid";
}

function expected(type: string): string {
  switch (type) {
    case "string":
      return "a string";
    case "array":
      return "a list";
    case "object":
    case "record":
      return "a mapping";
    case "int":
      return "an integer";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    default:
      return type;
  }
}

function describeValue(value: unknown): string {
  if (value === null || value === undefined) return "an empty value";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "a mapping";
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** `["effects", 0, "stripe.refund"]` → `effects[0].stripe.refund`. */
function field(rest: Path): string {
  let text = "";
  for (const seg of rest) {
    if (typeof seg === "number") text += `[${seg}]`;
    else text += text === "" ? seg : `.${seg}`;
  }
  return text;
}

/** The element a path belongs to (`transition "refund"`) and the path within it. */
function context(path: Path, raw: unknown): { ctx: string; rest: Path; transition?: string } {
  const [head, name] = path;
  switch (head) {
    case "entity":
    case "concurrency":
    case "bindings":
      return { ctx: head, rest: path.slice(1) };
    case "actors":
      if (name !== undefined) return { ctx: `actor "${name}"`, rest: path.slice(2) };
      break;
    case "transitions":
      if (name !== undefined) {
        return { ctx: `transition "${name}"`, rest: path.slice(2), transition: String(name) };
      }
      break;
    case "rules":
      if (typeof name === "number") {
        const ruleName = ruleNameAt(raw, name);
        return {
          ctx: ruleName !== undefined ? `rule "${ruleName}"` : `rules[${name}]`,
          rest: path.slice(2),
        };
      }
      break;
  }
  return { ctx: "spec", rest: path };
}

function ruleNameAt(raw: unknown, index: number): string | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const rules = (raw as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return undefined;
  const rule: unknown = rules[index];
  if (typeof rule !== "object" || rule === null) return undefined;
  const name = (rule as { name?: unknown }).name;
  return typeof name === "string" ? name : undefined;
}

// --- Allowed keys, read from the schema itself so suggestions never drift from the format. ---

interface SchemaNode {
  _zod: {
    def: {
      type: string;
      shape?: Record<string, SchemaNode>;
      innerType?: SchemaNode;
      valueType?: SchemaNode;
      element?: SchemaNode;
      options?: SchemaNode[];
      in?: SchemaNode;
    };
  };
}

/** Removes wrappers (optional, default, pipe, …) and expands unions. */
function unwrap(node: SchemaNode): SchemaNode[] {
  const def = node._zod.def;
  if (def.type === "union") return (def.options ?? []).flatMap(unwrap);
  const inner = def.innerType ?? (def.type === "pipe" ? def.in : undefined);
  return inner ? unwrap(inner) : [node];
}

function keysAt(path: Path): string[] {
  let nodes = unwrap(specSchema as unknown as SchemaNode);
  for (const seg of path) {
    nodes = nodes.flatMap((n) => {
      const def = n._zod.def;
      if (def.type === "object") {
        const child = def.shape?.[String(seg)];
        return child ? unwrap(child) : [];
      }
      if (def.type === "record" && def.valueType) return unwrap(def.valueType);
      if (def.type === "array" && def.element && typeof seg === "number") {
        return unwrap(def.element);
      }
      return [];
    });
  }
  const keys = new Set<string>();
  for (const n of nodes) for (const k of Object.keys(n._zod.def.shape ?? {})) keys.add(k);
  return [...keys];
}
