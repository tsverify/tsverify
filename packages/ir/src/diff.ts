import { compareStrings } from "./compare";
import type { Actor, BehaviorModel, Bindings, Transition } from "./model";
import { formatSymbolRef } from "./refs";

/**
 * Structural behavior diff between two spec models of the same behavior file (e.g. the PR base
 * and head), for `tsverify diff`. Every value is pre-formatted as a short string, so renderers never
 * re-derive formatting and the result is deterministic: items are sorted by name, fields keep
 * the fixed order of `*_FIELDS` below. Locations are ignored.
 */
export type ChangeKind = "added" | "removed" | "changed";

/** One field of an item that differs. `base`/`head` are formatted values (`""` for absent). */
export interface FieldChange {
  field: string;
  base: string;
  head: string;
}

/**
 * An item (state, transition, actor, rule) that differs. For `added`/`removed`, `fields` lists
 * the item's non-empty fields with the absent side `""`, so a renderer can show what came or went.
 */
export interface ItemChange {
  kind: ChangeKind;
  name: string;
  fields: FieldChange[];
}

export interface BehaviorDiff {
  /** The head name, or the base name when the behavior was removed. */
  behavior: string;
  /** `added`: no base model; `removed`: no head model; `unchanged`: every list below is empty. */
  kind: ChangeKind | "unchanged";
  /**
   * Top-level fields, in this order: `behavior` (the behavior name), `enforced` (`"yes"` / `""`),
   * then the entity's `name`, `state` field and `initial` state.
   */
  entity: FieldChange[];
  /** Fields: `terminal` (`"yes"` / `""`). */
  states: ItemChange[];
  /** Fields: `TRANSITION_FIELDS`. */
  transitions: ItemChange[];
  /** Fields: `trust`, `requires`. */
  actors: ItemChange[];
  /** Fields: `kind`, `expr` (the source text). */
  rules: ItemChange[];
  /** Fields: `persistence`, `client:<name>`, `guard:<ref>`, `effect:<name>` (only those that differ). */
  bindings: FieldChange[];
}

export const TRANSITION_FIELDS = [
  "from",
  "to",
  "by",
  "requires",
  "effects",
  "atomic",
  "idempotent",
  "after",
  "impl",
  "concurrency",
] as const;

type Fields = Record<string, string>;

const list = (xs: readonly string[]): string => [...xs].sort(compareStrings).join(", ");
const flag = (b: boolean): string => (b ? "yes" : "");

function transitionFields(t: Transition, model: BehaviorModel): Fields {
  return {
    from: t.from === "*" ? "*" : list(t.from),
    to: t.to,
    by: list(t.by),
    requires: list(t.requires.map((g) => g.raw)),
    effects: list(t.effects.map((e) => `${e.name} (${e.multiplicity})`)),
    atomic: flag(t.atomic),
    idempotent: flag(t.idempotent),
    after: t.after ?? "",
    impl: t.impl ? formatSymbolRef(t.impl) : "",
    concurrency: String(model.concurrency[t.name] ?? ""),
  };
}

function actorFields(a: Actor): Fields {
  return { trust: a.trust, requires: list(a.requires.map((g) => g.raw)) };
}

function bindingFields(b: Bindings): Fields {
  const out: Fields = { persistence: b.persistence ?? "" };
  for (const [k, c] of Object.entries(b.clients)) out[`client:${k}`] = `${c.module}#${c.export}`;
  for (const [k, g] of Object.entries(b.guards)) out[`guard:${k}`] = g.raw;
  for (const [k, e] of Object.entries(b.effects)) out[`effect:${k}`] = e;
  return out;
}

function fieldChanges(base: Fields, head: Fields, order?: readonly string[]): FieldChange[] {
  const keys =
    order ?? [...new Set([...Object.keys(base), ...Object.keys(head)])].sort(compareStrings);
  const out: FieldChange[] = [];
  for (const field of keys) {
    const b = base[field] ?? "";
    const h = head[field] ?? "";
    if (b !== h) out.push({ field, base: b, head: h });
  }
  return out;
}

function itemChanges<T>(
  base: ReadonlyMap<string, T>,
  head: ReadonlyMap<string, T>,
  fields: (item: T) => Fields,
  order?: readonly string[],
): ItemChange[] {
  const names = [...new Set([...base.keys(), ...head.keys()])].sort(compareStrings);
  const out: ItemChange[] = [];
  for (const name of names) {
    const b = base.get(name);
    const h = head.get(name);
    const bf = b === undefined ? {} : fields(b);
    const hf = h === undefined ? {} : fields(h);
    const changes = fieldChanges(bf, hf, order);
    if (b === undefined) out.push({ kind: "added", name, fields: changes });
    else if (h === undefined) out.push({ kind: "removed", name, fields: changes });
    else if (changes.length > 0) out.push({ kind: "changed", name, fields: changes });
  }
  return out;
}

function byName<T extends { name: string }>(xs: readonly T[] | undefined): Map<string, T> {
  return new Map((xs ?? []).map((x) => [x.name, x]));
}

function stateMap(m: BehaviorModel | undefined): Map<string, boolean> {
  return new Map((m?.entity.states ?? []).map((s) => [s, m?.entity.terminal.includes(s) ?? false]));
}

const ENTITY_FIELDS = ["behavior", "enforced", "name", "state", "initial"] as const;

function entityFields(m: BehaviorModel | undefined): Fields {
  if (m === undefined) return {};
  return {
    behavior: m.name,
    enforced: flag(m.enforced === true),
    name: m.entity.name,
    state: m.entity.stateField,
    initial: m.entity.initial,
  };
}

/**
 * Diff two models of one behavior. Pass `undefined` for a side that doesn't exist (a new or
 * deleted behavior file); at least one side must be given.
 */
export function diffModels(
  base: BehaviorModel | undefined,
  head: BehaviorModel | undefined,
): BehaviorDiff {
  const either = head ?? base;
  if (either === undefined) throw new Error("diffModels: both sides are undefined");
  const owner = (t: Transition) =>
    base?.transitions.includes(t) ? (base as BehaviorModel) : (head as BehaviorModel);

  const diff: BehaviorDiff = {
    behavior: either.name,
    kind: "unchanged",
    entity: fieldChanges(entityFields(base), entityFields(head), ENTITY_FIELDS),
    states: itemChanges(stateMap(base), stateMap(head), (t) => ({ terminal: flag(t) }), [
      "terminal",
    ]),
    transitions: itemChanges(
      byName(base?.transitions),
      byName(head?.transitions),
      (t) => transitionFields(t, owner(t)),
      TRANSITION_FIELDS,
    ),
    actors: itemChanges(
      new Map(Object.entries(base?.actors ?? {})),
      new Map(Object.entries(head?.actors ?? {})),
      actorFields,
      ["trust", "requires"],
    ),
    rules: itemChanges(
      byName(base?.rules),
      byName(head?.rules),
      (r) => ({ kind: r.kind, expr: r.source }),
      ["kind", "expr"],
    ),
    bindings: fieldChanges(
      base ? bindingFields(base.bindings) : {},
      head ? bindingFields(head.bindings) : {},
    ),
  };
  if (base === undefined) diff.kind = "added";
  else if (head === undefined) diff.kind = "removed";
  else if (
    [diff.entity, diff.states, diff.transitions, diff.actors, diff.rules, diff.bindings].some(
      (l) => l.length > 0,
    )
  ) {
    diff.kind = "changed";
  }
  return diff;
}
