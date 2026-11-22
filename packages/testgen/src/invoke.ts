/**
 * How a generated test calls an impl: the argument list, from `fixtures.args[t]` (with `$id` /
 * `$actor` substituted) or else from the extractor's `InvocationShape`.
 */
import type { ArgPath, InvocationShape } from "@tsverify/ir";
import { literal, member, propertyKey } from "./emit";

/** Name of the generated const holding the seeded entity's key. */
export const ID = "ID";
/** Name of the generated const holding the actor fixtures. */
export const ACTORS = "ACTORS";

export function actorExpr(actor: string): string {
  return `${ACTORS}${member(actor)}`;
}

/** Whether `value` (an args fixture) contains the string `token` anywhere. */
export function mentions(value: unknown, token: string): boolean {
  if (value === token) return true;
  if (Array.isArray(value)) return value.some((v) => mentions(v, token));
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some((v) => mentions(v, token));
  }
  return false;
}

export type ArgsResult = { ok: true; args: string } | { ok: false; reason: string };

/**
 * The argument list (without parentheses) for one call, acting as `actor` (an actor name with a
 * fixture) or as nobody.
 */
export function buildArgs(
  invocation: InvocationShape,
  fixtureArgs: readonly unknown[] | undefined,
  actor: string | undefined,
): ArgsResult {
  if (fixtureArgs !== undefined) {
    if (actor === undefined && mentions(fixtureArgs, "$actor")) {
      return { ok: false, reason: "`fixtures.args` uses `$actor` but no actor fixture applies" };
    }
    const replace = (v: unknown): string | undefined =>
      v === "$id" ? ID : v === "$actor" && actor !== undefined ? actorExpr(actor) : undefined;
    return { ok: true, args: fixtureArgs.map((v) => literal(v, replace)).join(", ") };
  }

  const slots: Slot[] = [];
  const placed = [
    place(slots, invocation.entityId, ID, "entity id"),
    invocation.actor && actor !== undefined
      ? place(slots, invocation.actor, actorExpr(actor), "actor")
      : undefined,
  ].find((error) => error !== undefined);
  if (placed !== undefined) return { ok: false, reason: placed };
  const args: string[] = [];
  for (let i = 0; i < slots.length; i++) args.push(render(slots[i]));
  return { ok: true, args: args.join(", ") };
}

type Slot = { code: string } | { fields: Map<string, Slot> } | undefined;

/** Puts `code` at `path` in the argument slots; returns an error message on a conflict. */
function place(slots: Slot[], path: ArgPath, code: string, what: string): string | undefined {
  if (path.path.length === 0) {
    if (slots[path.param] !== undefined) return conflict(path, what);
    slots[path.param] = { code };
    return undefined;
  }
  let slot = slots[path.param];
  if (slot === undefined) {
    slot = { fields: new Map() };
    slots[path.param] = slot;
  }
  let node = slot;
  for (const [i, key] of path.path.entries()) {
    if (!("fields" in node)) return conflict(path, what);
    const last = i === path.path.length - 1;
    const existing = node.fields.get(key);
    if (last) {
      if (existing !== undefined) return conflict(path, what);
      node.fields.set(key, { code });
      return undefined;
    }
    const next: Slot = existing ?? { fields: new Map() };
    node.fields.set(key, next);
    node = next;
  }
  return undefined;
}

function conflict(path: ArgPath, what: string): string {
  const where = [`parameter ${path.param}`, ...path.path].join(".");
  return `the invocation shape puts the ${what} at ${where}, which another argument already uses; add \`fixtures.args\` for this transition`;
}

function render(slot: Slot): string {
  if (slot === undefined) return "undefined";
  if ("code" in slot) return slot.code;
  const entries = [...slot.fields].map(([k, v]) => `${propertyKey(k)}: ${render(v)}`);
  return `{ ${entries.join(", ")} }`;
}
