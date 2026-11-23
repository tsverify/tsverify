import type {
  BehaviorModel,
  GuardRef,
  StorageFunction,
  StorageKind,
  StorageRole,
  Transition,
} from "@tsverify/ir";
import { compareStrings, formatSymbolRef, parseGuardRef, storageFunctions } from "@tsverify/ir";
import { type FindingCollector, list, suggest } from "./findings";
import type { Normalized } from "./normalize";
import type { Locator, Path } from "./positions";
import type { SpecInput } from "./schema";

/**
 * Semantic checks the schema cannot express (docs/behavior-format.md, "Semantic validation").
 * Everything is an error except terminal states with outgoing transitions and unused guard
 * bindings, which are warnings.
 */
export function validate(
  input: SpecInput,
  normalized: Normalized,
  locator: Locator,
  out: FindingCollector,
): void {
  new Validator(input, normalized, locator, out).run();
}

/** The roles each kind of storage function can take. */
const ALLOWED_ROLES: Record<StorageKind, readonly StorageRole[]> = {
  read: ["key", "_"],
  save: ["key", "entity", "patch", "_"],
  update: ["key", "from", "to", "patch", "_"],
  atomic: ["callback", "_"],
};

const KIND_TEXT: Record<StorageKind, string> = {
  read: "a read function",
  save: "a save function",
  update: "a conditional save (update)",
  atomic: "an atomic function",
};

class Validator {
  private readonly model: BehaviorModel;
  private readonly states: Set<string>;
  private readonly terminal: Set<string>;
  private readonly declaredStates: string;

  constructor(
    private readonly input: SpecInput,
    private readonly normalized: Normalized,
    private readonly locator: Locator,
    private readonly out: FindingCollector,
  ) {
    this.model = normalized.model;
    this.states = new Set(this.model.entity.states);
    this.terminal = new Set(this.model.entity.terminal);
    this.declaredStates = list(this.model.entity.states);
  }

  run(): void {
    this.entity();
    for (const t of this.model.transitions) this.transition(t);
    this.concurrency();
    this.fixtures();
    this.rules();
    this.guardBindings();
    this.unusedGuardBindings();
    this.effectBindings();
    this.storage();
  }

  /**
   * `bindings.storage`: not together with `persistence`; the named-function form has a read,
   * save or update function; each function's roles fit its kind; symbols are unique.
   */
  private storage(): void {
    const b = this.input.bindings;
    if (b?.storage === undefined) return;
    const base = ["bindings", "storage"];
    if (b.persistence !== undefined) {
      const keep =
        typeof b.storage === "string" ? `storage: ${b.storage}` : "the storage functions";
      this.out.error(
        this.locator.key(["bindings", "persistence"]),
        `bindings: "persistence" and "storage" are mutually exclusive (storage replaces persistence)`,
        { hint: `remove "persistence: ${b.persistence}" and keep ${keep}` },
      );
    }
    if (typeof b.storage === "string") return;

    const given = (kind: StorageKind) => {
      const v = (b.storage as Record<string, unknown>)[kind];
      return v !== undefined && !(Array.isArray(v) && v.length === 0);
    };
    if (!given("read") && !given("save") && !given("update")) {
      this.out.error(
        this.locator.key(base),
        "bindings.storage: names no read, save or update function (at least one is required)",
        {
          hint: `add \`read: path/to/file.ts#symbol\` (the function that loads one ${this.model.entity.name} by key) and \`save:\` (the one that persists it)`,
        },
      );
    }

    const binding = this.model.bindings.storage;
    if (binding === undefined) return;
    const bySymbol = new Map<string, string>();
    for (const { kind, fn } of storageFunctions(binding)) {
      const path = this.normalized.paths.get(fn) ?? [...base, kind];
      const label = `bindings.storage.${kind} "${formatSymbolRef(fn.ref)}"`;
      this.storageRoles(kind, fn, path, label);
      const previous = bySymbol.get(fn.ref.symbol);
      if (previous !== undefined) {
        this.out.error(
          this.locator.value(typeof this.valueAt(path) === "string" ? path : [...path, "fn"]),
          `${label}: function name "${fn.ref.symbol}" is already bound (as ${previous}); storage function names must be unique, because a call is identified by its name`,
          { hint: "bind each storage function once, under the kind it performs" },
        );
      } else {
        bySymbol.set(fn.ref.symbol, `${kind} "${formatSymbolRef(fn.ref)}"`);
      }
    }
  }

  private storageRoles(kind: StorageKind, fn: StorageFunction, path: Path, label: string): void {
    const explicit = Array.isArray((this.valueAt(path) as { args?: unknown } | undefined)?.args);
    const argsPath = explicit ? [...path, "args"] : path;
    const roleAt = (i: number) => this.locator.value(explicit ? [...argsPath, i] : path);
    const shown = `args: [${fn.args.join(", ")}]`;
    const allowed = ALLOWED_ROLES[kind];

    const seen = new Set<StorageRole>();
    fn.args.forEach((role, i) => {
      if (!allowed.includes(role)) {
        this.out.error(
          roleAt(i),
          `${label}: ${KIND_TEXT[kind]} takes no "${role}" argument (its roles: ${list(allowed)})`,
          { hint: `use "_" for an argument tsverify should ignore` },
        );
      } else if (role !== "_" && seen.has(role)) {
        this.out.error(
          roleAt(i),
          `${label}: role "${role}" appears twice in "args" (each role names one argument; "_" ignores one)`,
        );
      }
      seen.add(role);
    });

    const need = (message: string, hint: string) =>
      this.out.error(this.locator.value(argsPath), `${label}: ${message} (${shown})`, { hint });
    switch (kind) {
      case "read":
        if (!seen.has("key")) need('a read function needs a "key" argument', "e.g. args: [key]");
        break;
      case "save":
        if (seen.has("entity") && seen.has("patch")) {
          need(
            'a save function takes an "entity" or a "patch", not both',
            "e.g. args: [entity] or args: [key, patch]",
          );
        } else if (!seen.has("entity") && !(seen.has("key") && seen.has("patch"))) {
          need(
            'a save function needs an "entity" argument, or "key" and "patch"',
            "e.g. args: [entity] or args: [key, patch]",
          );
        }
        break;
      case "update":
        this.updateStates(fn, path, label, seen, need);
        break;
      case "atomic":
        if (!seen.has("callback")) {
          need('an atomic function needs a "callback" argument', "e.g. args: [callback]");
        }
        break;
    }
  }

  private updateStates(
    fn: StorageFunction,
    path: Path,
    label: string,
    seen: ReadonlySet<StorageRole>,
    need: (message: string, hint: string) => void,
  ): void {
    if (!seen.has("key")) {
      need('a conditional save (update) needs a "key" argument', "e.g. args: [key, from, to]");
    }
    const sides = [
      { role: "from", fixed: fn.from, what: "from-states", are: "are", example: "from: [paid]" },
      { role: "to", fixed: fn.to, what: "target state", are: "is", example: "to: refunded" },
    ] as const;
    for (const { role, fixed, what, are, example } of sides) {
      if (seen.has(role) && fixed !== undefined) {
        this.out.error(
          this.locator.key([...path, role]),
          `${label}: the ${what} ${are} given twice, by a "${role}" argument and by the fixed "${role}:" (keep one)`,
        );
      } else if (!seen.has(role) && fixed === undefined) {
        need(
          `a conditional save needs its ${what}: a "${role}" argument, or a fixed "${role}:"`,
          `add "${role}" to args, or write ${example}`,
        );
      }
    }
    const check = (state: string, statePath: Path, key: string) => {
      if (this.states.has(state)) return;
      this.out.error(
        this.locator.value(statePath),
        `${label}: unknown state "${state}" in "${key}" (declared: ${this.declaredStates})`,
        { hint: didYouMean(state, this.model.entity.states) },
      );
    };
    fn.from?.forEach((s, i) => {
      check(
        s,
        Array.isArray(this.valueAt([...path, "from"])) ? [...path, "from", i] : [...path, "from"],
        "from",
      );
    });
    if (fn.to !== undefined) check(fn.to, [...path, "to"], "to");
  }

  /** The raw input value at a YAML path (for telling the string form from the long form). */
  private valueAt(path: Path): unknown {
    let v: unknown = this.input;
    for (const seg of path) {
      if (typeof v !== "object" || v === null) return undefined;
      v = (v as Record<string | number, unknown>)[seg];
    }
    return v;
  }

  private entity(): void {
    const { states, initial, terminal } = this.model.entity;
    const seen = new Set<string>();
    states.forEach((s, i) => {
      if (seen.has(s)) {
        this.out.error(
          this.locator.value(["entity", "states", i]),
          `entity: duplicate state "${s}" in "states"`,
        );
      }
      seen.add(s);
    });
    this.checkState(initial, ["entity", "initial"], "entity", "initial");
    terminal.forEach((s, i) => {
      this.checkState(s, ["entity", "terminal", i], "entity", "terminal");
    });
  }

  private transition(t: Transition): void {
    const base = ["transitions", t.name];
    const label = `transition "${t.name}"`;
    const extra = { transition: t.name };

    if (t.from === "*") {
      const terminal = this.model.entity.terminal;
      if (terminal.length > 0) {
        this.out.warning(
          this.locator.value([...base, "from"]),
          `${label}: from "*" includes the terminal states ${list(terminal)}; terminal states should have no outgoing transitions`,
          { ...extra, hint: "list the non-terminal source states explicitly" },
        );
      }
    } else {
      t.from.forEach((s, i) => {
        const path = [...base, "from", i];
        if (s === "*") {
          this.out.error(
            this.locator.value(path),
            `${label}: "*" must be used on its own (from: "*"), not inside a list`,
            extra,
          );
        } else if (this.checkState(s, path, label, "from", t.name) && this.terminal.has(s)) {
          this.out.warning(
            this.locator.value(path),
            `${label}: terminal state "${s}" has an outgoing transition; terminal states should have no outgoing transitions`,
            { ...extra, hint: `remove "${s}" from "from", or from entity.terminal` },
          );
        }
      });
    }

    this.checkState(t.to, [...base, "to"], label, "to", t.name);

    const actors = Object.keys(this.model.actors).sort(compareStrings);
    t.by.forEach((a, i) => {
      if (this.model.actors[a]) return;
      this.out.error(
        this.locator.value([...base, "by", i]),
        `${label}: unknown actor "${a}" in "by" (declared: ${list(actors)})`,
        { ...extra, hint: didYouMean(a, actors) },
      );
    });

    const effects = new Set<string>();
    for (const e of t.effects) {
      if (effects.has(e.name)) {
        this.out.error(
          this.at(e, [...base, "effects"]),
          `${label}: duplicate effect "${e.name}" (effect names must be unique within a transition)`,
          extra,
        );
      }
      effects.add(e.name);
    }
  }

  private concurrency(): void {
    const names = this.model.transitions.map((t) => t.name);
    for (const key of Object.keys(this.input.concurrency?.max_parallel ?? {})) {
      if (names.includes(key)) continue;
      this.out.error(
        this.locator.key(["concurrency", "max_parallel", key]),
        `concurrency.max_parallel: unknown transition "${key}" (declared: ${list(names)})`,
        { hint: didYouMean(key, names) },
      );
    }
  }

  private fixtures(): void {
    const actors = Object.keys(this.model.actors);
    for (const key of Object.keys(this.input.fixtures?.actors ?? {})) {
      if (actors.includes(key)) continue;
      this.out.error(
        this.locator.key(["fixtures", "actors", key]),
        `fixtures.actors: unknown actor "${key}" (declared: ${list(actors)})`,
        { hint: didYouMean(key, actors) },
      );
    }
    const names = this.model.transitions.map((t) => t.name);
    for (const key of Object.keys(this.input.fixtures?.args ?? {})) {
      if (names.includes(key)) continue;
      this.out.error(
        this.locator.key(["fixtures", "args", key]),
        `fixtures.args: unknown transition "${key}" (declared: ${list(names)})`,
        { hint: didYouMean(key, names) },
      );
    }
  }

  private rules(): void {
    const effects = [
      ...new Set(this.model.transitions.flatMap((t) => t.effects.map((e) => e.name))),
    ].sort(compareStrings);
    const names = new Set<string>();
    for (const rule of this.model.rules) {
      const path = this.normalized.paths.get(rule) ?? ["rules"];
      const label = `rule "${rule.name}"`;
      if (names.has(rule.name)) {
        this.out.error(
          this.locator.value([...path, "name"]),
          `${label}: duplicate rule name (rule names must be unique)`,
        );
      }
      names.add(rule.name);

      for (const ref of this.normalized.ruleRefs.get(rule) ?? []) {
        const at = this.locator.inScalar([...path, rule.kind], ref.offset, ref.end);
        if (ref.kind === "state" && !this.states.has(ref.name)) {
          this.out.error(
            at,
            `${label}: unknown state "${ref.name}" (declared: ${this.declaredStates})`,
            { hint: didYouMean(ref.name, this.model.entity.states) },
          );
        }
        if (ref.kind === "effect" && !effects.includes(ref.name)) {
          const declared =
            effects.length > 0
              ? `declared on transitions: ${list(effects)}`
              : "no transition declares any effects";
          this.out.error(at, `${label}: unknown effect "${ref.name}" (${declared})`, {
            hint: didYouMean(ref.name, effects),
          });
        }
      }
    }
  }

  /** With any guard bound, every guard used must be bound (a spec with none is design-only). */
  private guardBindings(): void {
    if (Object.keys(this.input.bindings?.guards ?? {}).length === 0) return;
    const bound = Object.keys(this.model.bindings.guards);
    const check = (guard: GuardRef, label: string, fallback: Path, transition?: string) => {
      if (this.model.bindings.guards[guard.raw]) return;
      this.out.error(
        this.at(guard, fallback),
        `${label}: guard "${guard.raw}" has no binding in bindings.guards (bound: ${list(bound)})`,
        {
          transition,
          hint: `add \`${guard.raw}: path/to/file.ts#symbol\` under bindings.guards`,
        },
      );
    };
    for (const actor of Object.values(this.model.actors)) {
      for (const g of actor.requires) check(g, `actor "${actor.name}"`, ["actors", actor.name]);
    }
    for (const t of this.model.transitions) {
      for (const g of t.requires) {
        check(g, `transition "${t.name}"`, ["transitions", t.name], t.name);
      }
    }
  }

  /**
   * A bound guard no transition or actor requires is dead configuration (often a typo in a
   * `requires` item or in the binding key). Clients are not checked: persistence clients such as
   * `db` are legitimately referenced by no effect or guard.
   */
  private unusedGuardBindings(): void {
    const used = new Set([
      ...Object.values(this.model.actors).flatMap((a) => a.requires.map((g) => g.raw)),
      ...this.model.transitions.flatMap((t) => t.requires.map((g) => g.raw)),
    ]);
    const reported = new Set<string>();
    for (const key of Object.keys(this.input.bindings?.guards ?? {})) {
      const raw = parseGuardRef(key)?.raw;
      // Malformed and duplicate keys are already errors (normalize.ts).
      if (raw === undefined || !this.model.bindings.guards[raw]) continue;
      if (used.has(raw) || reported.has(raw)) continue;
      reported.add(raw);
      this.out.warning(
        this.locator.key(["bindings", "guards", key]),
        `bindings.guards: unused guard binding "${raw}" (no transition or actor requires it)`,
        { hint: `add "${raw}" to a "requires" list, or remove the binding` },
      );
    }
  }

  /**
   * `bindings.effects` keys are effects declared on some transition, and each value's first
   * segment is a bound client (when any client is bound).
   */
  private effectBindings(): void {
    const declared = [
      ...new Set(this.model.transitions.flatMap((t) => t.effects.map((e) => e.name))),
    ].sort(compareStrings);
    const clients = Object.keys(this.model.bindings.clients);
    for (const [key, target] of Object.entries(this.input.bindings?.effects ?? {})) {
      const path = ["bindings", "effects", key];
      if (!declared.includes(key)) {
        const where =
          declared.length > 0
            ? `declared on transitions: ${list(declared)}`
            : "no transition declares any effects";
        this.out.error(
          this.locator.key(path),
          `bindings.effects: unknown effect "${key}" (${where})`,
          { hint: didYouMean(key, declared) },
        );
      }
      const client = target.split(".")[0] as string;
      if (clients.length > 0 && !clients.includes(client)) {
        this.out.error(
          this.locator.value(path),
          `bindings.effects "${key}": unknown client "${client}" in "${target}" (bound clients: ${list(clients)})`,
          {
            hint:
              didYouMean(client, clients) ??
              `add \`${client}: { module: path/to/file.ts, export: ${client} }\` under bindings.clients`,
          },
        );
      }
    }
  }

  /** Reports an unknown state; returns true if the state is declared. */
  private checkState(
    state: string,
    path: Path,
    label: string,
    key: string,
    transition?: string,
  ): boolean {
    if (this.states.has(state)) return true;
    this.out.error(
      this.locator.value(path),
      `${label}: unknown state "${state}" in "${key}" (declared: ${this.declaredStates})`,
      { transition, hint: didYouMean(state, this.model.entity.states) },
    );
    return false;
  }

  private at(element: object, fallback: Path) {
    return this.locator.value(this.normalized.paths.get(element) ?? fallback);
  }
}

function didYouMean(word: string, candidates: readonly string[]): string | undefined {
  const guess = suggest(word, candidates);
  return guess ? `did you mean "${guess}"?` : undefined;
}
