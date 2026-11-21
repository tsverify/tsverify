/**
 * Checker throughput benchmark (doc 5 §5 budget: ≥ 500k states/s on a synthetic entity model).
 *
 *   pnpm exec tsx packages/checker/bench/throughput.ts [transitions=5] [concurrency=3]
 *
 * The model is a ring of `states` statuses with `transitions` non-atomic transitions, each
 * readable from two adjacent statuses, so many check-then-act windows overlap. Every transition
 * fires an at-least-once effect, and every third one fires an exactly-once effect.
 */
import type { BehaviorModel, Transition } from "@tsv/ir";
import { check } from "../src/index";

function syntheticModel(transitions: number, concurrency: number, states = 4): BehaviorModel {
  const names = Array.from({ length: states }, (_, i) => `s${i}`);
  const ts: Transition[] = Array.from({ length: transitions }, (_, i) => ({
    name: `t${String(i).padStart(2, "0")}`,
    from: [names[i % states] as string, names[(i + 1) % states] as string],
    to: names[(i + 2) % states] as string,
    by: ["system"],
    requires: [],
    effects: [
      { name: `log.t${i % 3}`, multiplicity: "at-least-once" },
      ...(i % 3 === 0 ? [{ name: `once.t${i}`, multiplicity: "exactly-once" as const }] : []),
    ],
    atomic: false,
    idempotent: i % 2 === 0,
  }));
  return {
    kind: "entity",
    name: `synthetic ${transitions}x${concurrency}`,
    origin: "spec",
    entity: { name: "Thing", stateField: "status", states: names, initial: "s0", terminal: [] },
    actors: { system: { name: "system", trust: "internal", requires: [] } },
    transitions: ts,
    rules: [
      {
        name: "never s3 with two logs",
        kind: "never",
        source: "status == s3 and count(effect log.t0) > 2",
        expr: {
          type: "and",
          left: { type: "status-cmp", op: "==", value: "s3" },
          right: { type: "effect-count", effect: "log.t0", op: ">", value: 2 },
        },
      },
      {
        name: "eventually s0",
        kind: "eventually",
        source: "status == s0",
        expr: { type: "status-cmp", op: "==", value: "s0" },
      },
    ],
    concurrency: Object.fromEntries(ts.map((t) => [t.name, concurrency])),
    bindings: { clients: {}, guards: {}, effects: {} },
  };
}

const transitions = Number(process.argv[2] ?? 5);
const concurrency = Number(process.argv[3] ?? 3);

// Warm up the JIT on a smaller instance.
check(syntheticModel(Math.max(1, transitions - 2), concurrency), { maxStates: 5_000_000 });

const model = syntheticModel(transitions, concurrency);
const { stats, findings } = check(model, { maxStates: 5_000_000 });
const perSecond = Math.round(stats.states / (stats.durationMs / 1000));
console.log(
  [
    `model:      ${model.name} (${model.entity.states.length} statuses, non-atomic)`,
    `states:     ${stats.states.toLocaleString("en-US")}${stats.complete ? "" : " (state limit hit)"}`,
    `edges:      ${stats.edges.toLocaleString("en-US")}`,
    `findings:   ${findings.length}`,
    `time:       ${stats.durationMs.toFixed(0)} ms`,
    `throughput: ${perSecond.toLocaleString("en-US")} states/s (budget ≥ 500,000)`,
  ].join("\n"),
);
