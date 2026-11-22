import type { BehaviorModel, GuardRef, Transition } from "@tsv/ir";
import { compareStrings } from "@tsv/ir";
import { type FindingCollector, list, suggest } from "./findings";
import type { Normalized } from "./normalize";
import type { Locator, Path } from "./positions";
import type { SpecInput } from "./schema";

/**
 * Semantic checks the schema cannot express (docs/behavior-format.md, "Semantic validation").
 * Everything is an error except terminal states with outgoing transitions, which is a warning.
 */
export function validate(
  input: SpecInput,
  normalized: Normalized,
  locator: Locator,
  out: FindingCollector,
): void {
  new Validator(input, normalized, locator, out).run();
}

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
