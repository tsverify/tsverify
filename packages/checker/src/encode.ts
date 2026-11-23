import type { BehaviorModel, EffectMultiplicity } from "@tsverify/ir";
import { type ExprAccess, effectConstants } from "./eval";
import { allocateWorkerClasses, type WorkerClasses } from "./symmetry";

/**
 * Compact state encoding.
 *
 * A state is a fixed-width vector of small unsigned integers (a `Uint16Array` row):
 *
 *   [ status | per transition: idle[, checked] | per effect: count ]
 *
 * Field 0 is the status index. Worker fields hold class counts (see `symmetry.ts`); effect fields
 * hold counts saturated at `cap` (see `effectCap`). Every field is bounded by the model's
 * concurrency, so a row is a few dozen bytes and hashes and compares quickly.
 *
 * Only effects something checks get a count: an `exactly-once` effect (the `effect-multiplicity`
 * built-in) and one a rule names (`count(effect …)`). An `idempotent` or `at-least-once` effect no
 * rule names (a call no spec effect maps to is `at-least-once`) is never looked at, so counting
 * it would only multiply the states; it is not in the state, nor in traces.
 */
export const STATUS = 0;

export interface EffectCode {
  name: string;
  field: number;
  /** Counts saturate here: `max(2, 1 + largest constant compared against this effect)`. */
  cap: number;
  /** `exactly-once` if any transition declares it so, else the first declaration's multiplicity. */
  multiplicity: EffectMultiplicity;
  /** Names of the transitions that emit this effect, sorted. */
  emitters: string[];
}

export interface TransitionCode {
  /** Position in `Layout.transitions` (the model's order). */
  index: number;
  name: string;
  atomic: boolean;
  idempotent: boolean;
  concurrency: number;
  /** Target status index. */
  to: number;
  /** 1 where the status at that index is in `from` (all 1 for `"*"`). */
  enabledFrom: Uint8Array;
  workers: WorkerClasses;
  /** Field offsets of the effects this transition increments. */
  effectFields: number[];
  /** Saturation caps, parallel to `effectFields`. */
  effectCaps: number[];
}

export interface Layout {
  /** Fields per state. */
  width: number;
  states: readonly string[];
  stateIndex: ReadonlyMap<string, number>;
  initial: number;
  /** 1 where the status at that index is terminal. */
  terminal: Uint8Array;
  /** Sorted by name. */
  effects: readonly EffectCode[];
  effectIndex: ReadonlyMap<string, EffectCode>;
  transitions: readonly TransitionCode[];
}

/** Largest value a single field may hold. */
const FIELD_MAX = 0xffff;

function lookupState(stateIndex: ReadonlyMap<string, number>, name: string, what: string): number {
  const i = stateIndex.get(name);
  if (i === undefined) throw new Error(`checker: ${what} refers to unknown state "${name}"`);
  return i;
}

/** Builds the field layout for a model. Throws on malformed models (programmer error). */
export function buildLayout(model: BehaviorModel): Layout {
  const states = model.entity.states;
  if (states.length > FIELD_MAX) throw new Error("checker: too many states");
  const stateIndex = new Map(states.map((s, i) => [s, i] as const));
  const initial = lookupState(stateIndex, model.entity.initial, "entity.initial");
  const terminal = new Uint8Array(states.length);
  for (const t of model.entity.terminal) {
    const i = stateIndex.get(t);
    if (i !== undefined) terminal[i] = 1;
  }

  // Effects: every effect declared on a transition that something checks, sorted by name.
  const constants = effectConstants(model.rules.map((r) => r.expr));
  const effectDecls = new Map<
    string,
    { multiplicity: EffectMultiplicity; emitters: Set<string> }
  >();
  for (const t of model.transitions) {
    for (const e of t.effects) {
      const entry = effectDecls.get(e.name);
      if (!entry) {
        effectDecls.set(e.name, { multiplicity: e.multiplicity, emitters: new Set([t.name]) });
      } else {
        entry.emitters.add(t.name);
        if (e.multiplicity === "exactly-once") entry.multiplicity = "exactly-once";
      }
    }
  }
  // Only counts something checks: an exactly-once effect (`effect-multiplicity`), or one a rule
  // names. Any other count is never looked at, and would only multiply the states.
  const effectNames = [...effectDecls.keys()]
    .filter((name) => effectDecls.get(name)?.multiplicity === "exactly-once" || constants.has(name))
    .sort();

  let offset = STATUS + 1;
  const transitions: TransitionCode[] = model.transitions.map((t, index) => {
    const concurrency = model.concurrency[t.name];
    if (concurrency === undefined) {
      throw new Error(`checker: no concurrency bound for transition "${t.name}"`);
    }
    if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > FIELD_MAX) {
      throw new Error(`checker: invalid concurrency ${concurrency} for "${t.name}"`);
    }
    const enabledFrom = new Uint8Array(states.length);
    if (t.from === "*") enabledFrom.fill(1);
    else for (const s of t.from) enabledFrom[lookupState(stateIndex, s, `${t.name}.from`)] = 1;
    const { classes, next } = allocateWorkerClasses(t.atomic, offset);
    offset = next;
    return {
      index,
      name: t.name,
      atomic: t.atomic,
      idempotent: t.idempotent,
      concurrency,
      to: lookupState(stateIndex, t.to, `${t.name}.to`),
      enabledFrom,
      workers: classes,
      effectFields: [],
      effectCaps: [],
    };
  });

  const effects: EffectCode[] = effectNames.map((name) => {
    const decl = effectDecls.get(name) as {
      multiplicity: EffectMultiplicity;
      emitters: Set<string>;
    };
    return {
      name,
      field: offset++,
      cap: Math.max(2, 1 + (constants.get(name) ?? 0)),
      multiplicity: decl.multiplicity,
      emitters: [...decl.emitters].sort(),
    };
  });
  const effectIndex = new Map(effects.map((e) => [e.name, e] as const));
  model.transitions.forEach((t, i) => {
    const code = transitions[i] as TransitionCode;
    // Increment each distinct effect once per firing, in effect-name order.
    for (const name of [...new Set(t.effects.map((e) => e.name))].sort()) {
      const e = effectIndex.get(name);
      if (!e) continue; // not counted
      code.effectFields.push(e.field);
      code.effectCaps.push(Math.min(e.cap, FIELD_MAX));
    }
  });

  return {
    width: offset,
    states,
    stateIndex,
    initial,
    terminal,
    effects,
    effectIndex,
    transitions,
  };
}

/** The initial state: initial status, every worker idle, every effect count 0. */
export function initialState(layout: Layout): Uint16Array {
  const v = new Uint16Array(layout.width);
  v[STATUS] = layout.initial;
  for (const t of layout.transitions) v[t.workers.idle] = t.concurrency;
  return v;
}

/** Status name and (saturated) effect counts of an encoded state. */
export function decodeState(
  layout: Layout,
  v: Uint16Array,
): { status: string; effects: Record<string, number> } {
  const effects: Record<string, number> = {};
  for (const e of layout.effects) effects[e.name] = v[e.field] as number;
  return { status: layout.states[v[STATUS] as number] as string, effects };
}

/** Expression access over encoded rows, for `compileExpr`. */
export function encodedAccess(layout: Layout): ExprAccess<Uint16Array> {
  return {
    statusIs(value) {
      const i = layout.stateIndex.get(value);
      return i === undefined ? () => false : (s) => s[STATUS] === i;
    },
    count(effect) {
      const e = layout.effectIndex.get(effect);
      if (e === undefined) return () => 0;
      const field = e.field;
      return (s) => s[field] as number;
    },
  };
}
