import {
  type Actor,
  type BehaviorModel,
  type Bindings,
  type ClientBinding,
  compareStrings,
  defaultStorageArgs,
  type EffectDecl,
  type EntityDecl,
  type Fixtures,
  type GuardBinding,
  type GuardRef,
  parseGuardBinding,
  parseGuardRef,
  parseSymbolRef,
  type Rule,
  STORAGE_KINDS,
  type StorageBinding,
  type StorageFunction,
  type StorageKind,
  type StorageRole,
  type Transition,
} from "@tsverify/ir";
import type { FindingCollector } from "./findings";
import type { Locator, Path } from "./positions";
import { type NameRef, parseRule } from "./rules/parser";
import { RULE_KINDS, type RuleInput, type SpecInput, type TransitionInput } from "./schema";

export const DEFAULT_CONCURRENCY = 2;

type StorageInput = Exclude<NonNullable<NonNullable<SpecInput["bindings"]>["storage"]>, string>;
/** One item of `storage.read` / `save` / `update` / `atomic`, as written. */
type StorageLongInput = {
  fn: string;
  args?: StorageRole[];
  returns?: StorageFunction["returns"];
  from?: string | string[];
  to?: string;
};
type StorageItemInput = string | StorageLongInput;

export interface Normalized {
  model: BehaviorModel;
  /** YAML path of each normalized element (guard refs, effects, rules…), for later findings. */
  paths: WeakMap<object, Path>;
  /** State / effect names referenced by each parsed rule. */
  ruleRefs: WeakMap<Rule, NameRef[]>;
}

/**
 * Schema-valid input → `BehaviorModel`: applies defaults, expands shorthands, canonicalises guards,
 * parses `impl` refs and rule expressions (reporting malformed ones), and sorts by name.
 */
export function normalize(
  input: SpecInput,
  file: string,
  locator: Locator,
  out: FindingCollector,
): Normalized {
  const n = new Normalizer(locator, out);
  const transitionNames = Object.keys(input.transitions).sort(compareStrings);
  const concurrencyDefault = input.concurrency?.default ?? DEFAULT_CONCURRENCY;
  const maxParallel = input.concurrency?.max_parallel ?? {};

  const model: BehaviorModel = {
    kind: "entity",
    name: input.behavior,
    ...(input.summary !== undefined && { summary: input.summary }),
    ...(input.enforced === true && { enforced: true }),
    origin: "spec",
    file,
    entity: n.entity(input.entity),
    actors: Object.fromEntries(
      Object.keys(input.actors)
        .sort(compareStrings)
        .map((name) => [name, n.actor(name, input.actors[name] as SpecInput["actors"][string])]),
    ),
    transitions: transitionNames.map((name) =>
      n.transition(name, input.transitions[name] as TransitionInput),
    ),
    rules: (input.rules ?? []).flatMap((rule, i) => n.rule(rule, i)),
    concurrency: Object.fromEntries(
      transitionNames.map((name) => [name, maxParallel[name] ?? concurrencyDefault]),
    ),
    bindings: n.bindings(input.bindings),
    ...(input.fixtures && { fixtures: n.fixtures(input.fixtures) }),
  };
  return { model, paths: n.paths, ruleRefs: n.ruleRefs };
}

/** `a` or `[a, b]` → items with the YAML path of each. */
export function itemsOf<T>(value: T | T[] | undefined, base: Path): { value: T; path: Path }[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((v, i) => ({ value: v, path: [...base, i] }));
  return [{ value, path: base }];
}

class Normalizer {
  readonly paths = new WeakMap<object, Path>();
  readonly ruleRefs = new WeakMap<Rule, NameRef[]>();

  constructor(
    private readonly locator: Locator,
    private readonly out: FindingCollector,
  ) {}

  entity(e: SpecInput["entity"]): EntityDecl {
    return {
      name: e.name,
      stateField: e.state,
      states: e.states,
      initial: e.initial,
      terminal: e.terminal ?? [],
      at: this.locator.entry(["entity"]),
    };
  }

  actor(name: string, a: SpecInput["actors"][string]): Actor {
    const base = ["actors", name];
    return {
      name,
      trust: a.trust,
      requires: this.guards(a.requires, [...base, "requires"], `actor "${name}"`),
      at: this.locator.entry(base),
    };
  }

  transition(name: string, t: TransitionInput): Transition {
    const base = ["transitions", name];
    const label = `transition "${name}"`;
    const from = t.from === "*" ? undefined : itemsOf(t.from, [...base, "from"]);
    const by = itemsOf(t.by, [...base, "by"]);
    const transition: Transition = {
      name,
      from: from === undefined ? "*" : from.map((i) => i.value),
      to: t.to,
      by: by.map((i) => i.value),
      requires: this.guards(t.requires, [...base, "requires"], label, name),
      effects: (t.effects ?? []).map((e, i) => this.effect(e, [...base, "effects", i])),
      atomic: t.atomic ?? false,
      idempotent: t.idempotent ?? false,
    };
    if (t.after !== undefined) transition.after = t.after;
    if (t.impl !== undefined) {
      const impl = parseSymbolRef(t.impl);
      if (impl) transition.impl = impl;
      else {
        this.out.error(
          this.locator.value([...base, "impl"]),
          `${label}: malformed impl "${t.impl}" (expected "path/to/file.ts#symbol")`,
          { transition: name },
        );
      }
    }
    transition.at = this.locator.entry(base);
    if (from !== undefined) transition.fromAt = from.map((i) => this.locator.value(i.path));
    transition.byAt = by.map((i) => this.locator.value(i.path));
    return transition;
  }

  rule(r: RuleInput, index: number): Rule[] {
    const kind = RULE_KINDS.find((k) => r[k] !== undefined) ?? "always";
    const source = String(r[kind] ?? "");
    const path = ["rules", index, kind];
    const parsed = parseRule(source);
    if ("error" in parsed) {
      const { offset } = parsed.error;
      this.out.error(
        this.locator.inScalar(path, offset, offset),
        `rule "${r.name}": syntax error in "${kind}" at character ${offset + 1}: ${parsed.error.message}`,
      );
      return [];
    }
    const rule: Rule = {
      name: r.name,
      kind,
      expr: parsed.expr,
      source,
      at: this.locator.value(["rules", index]),
    };
    this.paths.set(rule, ["rules", index]);
    this.ruleRefs.set(rule, parsed.refs);
    return [rule];
  }

  fixtures(f: NonNullable<SpecInput["fixtures"]>): Fixtures {
    const at = this.locator.entry(["fixtures"]);
    return {
      entity: { ...(f.entity ?? {}) },
      actors: { ...(f.actors ?? {}) },
      args: { ...(f.args ?? {}) },
      ...(at && { at }),
    };
  }

  bindings(b: SpecInput["bindings"]): Bindings {
    const clients: Record<string, ClientBinding> = {};
    for (const name of Object.keys(b?.clients ?? {}).sort(compareStrings)) {
      const c = b?.clients?.[name] as { module: string; export: string };
      clients[name] = {
        module: c.module,
        export: c.export,
        at: this.locator.entry(["bindings", "clients", name]),
      };
    }

    const guards: [string, GuardBinding][] = [];
    const boundAs = new Map<string, string>();
    for (const [key, target] of Object.entries(b?.guards ?? {})) {
      const path = ["bindings", "guards", key];
      const guard = parseGuardRef(key);
      if (!guard) {
        this.out.error(
          this.locator.key(path),
          `bindings.guards: malformed guard "${key}" (expected a name such as "owner" or "role(admin)")`,
        );
        continue;
      }
      const binding = parseGuardBinding(target);
      if (!binding) {
        this.out.error(
          this.locator.value(path),
          `bindings.guards "${key}": malformed binding "${target}" (expected "path/to/file.ts#symbol" or "path/to/file.ts#symbol(args)")`,
        );
        continue;
      }
      const previous = boundAs.get(guard.raw);
      if (previous !== undefined) {
        this.out.error(
          this.locator.key(path),
          `bindings.guards: guard "${guard.raw}" is bound twice (as "${previous}" and "${key}")`,
        );
        continue;
      }
      boundAs.set(guard.raw, key);
      guards.push([guard.raw, { ...binding, at: this.locator.entry(path) }]);
    }
    guards.sort((x, y) => compareStrings(x[0], y[0]));

    const effectEntries = Object.entries(b?.effects ?? {}).sort((x, y) =>
      compareStrings(x[0], y[0]),
    );
    const effects = Object.fromEntries(effectEntries);
    const effectsAt = Object.fromEntries(
      effectEntries.map(([key]) => [key, this.locator.entry(["bindings", "effects", key])]),
    );

    // `storage: <preset>` is `persistence: <preset>`. Both at once is an error (validate.ts); the
    // preset `storage:` wins.
    const preset = typeof b?.storage === "string" ? b.storage : b?.persistence;
    const storage =
      b?.storage !== undefined && typeof b.storage !== "string"
        ? this.storage(b.storage)
        : undefined;
    return {
      ...(preset !== undefined && { persistence: preset }),
      ...(storage !== undefined && { storage }),
      clients,
      guards: Object.fromEntries(guards),
      effects,
      effectsAt,
    };
  }

  /**
   * The named-function form of `bindings.storage`: refs parsed (malformed ones reported), default
   * roles applied, `from` made a list. Roles and states are checked by `validate.ts`.
   */
  private storage(s: StorageInput): StorageBinding {
    const base = ["bindings", "storage"];
    const binding: StorageBinding = {
      key: s.key ?? "id",
      read: [],
      save: [],
      update: [],
      atomic: [],
    };
    for (const kind of STORAGE_KINDS) {
      for (const item of itemsOf<StorageItemInput>(s[kind], [...base, kind])) {
        const fn = this.storageFunction(kind, item.value, item.path);
        if (fn) binding[kind].push(fn);
      }
    }
    binding.at = this.locator.entry(base);
    return binding;
  }

  private storageFunction(
    kind: StorageKind,
    value: StorageItemInput,
    path: Path,
  ): StorageFunction | undefined {
    const long = typeof value === "string" ? undefined : (value as StorageLongInput);
    const text = long?.fn ?? (value as string);
    const ref = parseSymbolRef(text);
    if (!ref) {
      this.out.error(
        this.locator.value(long ? [...path, "fn"] : path),
        `bindings.storage.${kind}: malformed function "${text}" (expected "path/to/file.ts#symbol")`,
      );
      return undefined;
    }
    const from = typeof long?.from === "string" ? [long.from] : long?.from;
    const to = long?.to;
    const fn: StorageFunction = {
      ref,
      args: long?.args
        ? [...long.args]
        : defaultStorageArgs(kind, {
            ...(from !== undefined && { from }),
            ...(to !== undefined && { to }),
          }),
    };
    if (long?.returns !== undefined) fn.returns = long.returns;
    if (from !== undefined) fn.from = [...from];
    if (to !== undefined) fn.to = to;
    fn.at = this.locator.value(path);
    this.paths.set(fn, path);
    return fn;
  }

  private guards(
    value: string | string[] | undefined,
    base: Path,
    label: string,
    transition?: string,
  ): GuardRef[] {
    const refs: GuardRef[] = [];
    for (const item of itemsOf(value, base)) {
      const ref = parseGuardRef(item.value);
      if (!ref) {
        this.out.error(
          this.locator.value(item.path),
          `${label}: malformed guard "${item.value}" in "requires" (expected a name such as "owner" or "role(admin)")`,
          { transition },
        );
        continue;
      }
      ref.at = this.locator.value(item.path);
      this.paths.set(ref, item.path);
      refs.push(ref);
    }
    return refs;
  }

  private effect(e: string | Record<string, string>, path: Path): EffectDecl {
    const [name, multiplicity] =
      typeof e === "string" ? [e, "exactly-once"] : (Object.entries(e)[0] as [string, string]);
    const decl: EffectDecl = {
      name,
      multiplicity: multiplicity as EffectDecl["multiplicity"],
      at: this.locator.value(path),
    };
    this.paths.set(decl, path);
    return decl;
  }
}
