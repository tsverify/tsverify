import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BehaviorModel,
  Bindings,
  EffectDecl,
  GuardRef,
  SourceLocation,
  Transition,
} from "@tsverify/ir";
import { parseSymbolRef } from "@tsverify/ir";
import { expect } from "vitest";
import { type ExtractResult, extractAll } from "../src/index";

export const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

export function fixtureRoot(name: string): string {
  return join(FIXTURES, name);
}

export interface TransitionSpec {
  name: string;
  /** `file#symbol`, relative to the fixture root. */
  impl?: string;
  from?: string[];
  to: string;
  by?: string[];
  requires?: GuardRef[];
  effects?: EffectDecl[];
  atomic?: boolean;
  idempotent?: boolean;
  at?: SourceLocation;
}

export function transition(t: TransitionSpec): Transition {
  const impl = t.impl === undefined ? undefined : parseSymbolRef(t.impl);
  return {
    name: t.name,
    from: t.from ?? ["paid"],
    to: t.to,
    by: t.by ?? ["admin"],
    requires: t.requires ?? [],
    effects: t.effects ?? [],
    atomic: t.atomic ?? true,
    idempotent: t.idempotent ?? false,
    ...(impl ? { impl } : {}),
    ...(t.at ? { at: t.at } : {}),
  };
}

/** Bindings of the shared fixture library (`test/fixtures/_lib`). */
export function libBindings(): Bindings {
  return {
    persistence: "assign",
    clients: {
      audit: { module: "../_lib/clients.ts", export: "audit" },
      db: { module: "../_lib/db.ts", export: "db" },
      email: { module: "../_lib/clients.ts", export: "email" },
      ledger: { module: "../_lib/clients.ts", export: "ledger" },
      stripe: { module: "../_lib/clients.ts", export: "stripe" },
    },
    guards: {
      owner: { file: "../_lib/guards.ts", symbol: "requireOwner", args: [], raw: "requireOwner" },
      "role(admin)": {
        file: "../_lib/guards.ts",
        symbol: "requireRole",
        args: ["admin"],
        raw: '../_lib/guards.ts#requireRole("admin")',
      },
    },
    effects: { "email.receipt": "email.send", "stripe.refund": "stripe.refunds.create" },
  };
}

/** An Order spec over the shared fixture library. */
export function orderSpec(transitions: TransitionSpec[], bindings = libBindings()): BehaviorModel {
  const ts = transitions.map(transition).sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    kind: "entity",
    name: "Fixture orders",
    origin: "spec",
    entity: {
      name: "Order",
      stateField: "status",
      states: ["draft", "pending_payment", "paid", "shipped", "refunded", "cancelled"],
      initial: "draft",
      terminal: ["shipped", "refunded", "cancelled"],
    },
    actors: {
      admin: {
        name: "admin",
        trust: "authenticated",
        requires: [{ name: "role", args: ["admin"], raw: "role(admin)" }],
      },
      customer: { name: "customer", trust: "untrusted", requires: [] },
      system: { name: "system", trust: "internal", requires: [] },
    },
    transitions: ts,
    rules: [],
    concurrency: Object.fromEntries(ts.map((t) => [t.name, 2])),
    bindings,
  };
}

/**
 * Extracts `spec` from a fixture. The shared bindings (`libBindings`) bind every client of the
 * fixture library, most of which a given fixture never calls, so the "bound but never called"
 * warnings (`unanalyzable:<behavior>:binding:…`) are left out unless `bindingWarnings` is set.
 */
export function extractFixture(
  fixture: string,
  spec: BehaviorModel,
  options: { bindingWarnings?: boolean } = {},
): ExtractResult {
  const { results } = extractAll([spec], { projectRoot: fixtureRoot(fixture) });
  const result = results[0] as ExtractResult;
  return options.bindingWarnings ? result : withoutBindingWarnings(result);
}

/** `result` without the "bound but never called" warnings (see `extractFixture`). */
export function withoutBindingWarnings(result: ExtractResult): ExtractResult {
  return { ...result, findings: result.findings.filter((f) => !isBindingWarning(f)) };
}

function isBindingWarning(f: { id: string; behavior?: string }): boolean {
  return f.id.startsWith(`unanalyzable:${f.behavior}:binding:`);
}

export function transitionOf(result: ExtractResult, name: string): Transition {
  const t = result.model?.transitions.find((x) => x.name === name);
  if (!t) {
    const names = result.model?.transitions.map((x) => x.name).join(", ");
    throw new Error(`no code transition "${name}" (have: ${names})`);
  }
  return t;
}

export function guardKeys(t: Transition): string[] {
  return t.requires.map((g) => g.raw);
}

/**
 * `guards[].dominates` and `guardSets` agree: a key dominates (is in `requires`, and every
 * `guards` entry of it says `dominates`) iff every guard set contains it.
 */
export function expectDominanceMatchesSets(t: Transition): void {
  const sites = t.sites;
  if (!sites?.guardSets) return;
  const sets = sites.guardSets;
  const keys = [...new Set([...sites.guards.map((g) => g.guard), ...sets.flat()])].sort();
  const inEvery = keys.filter((k) => sets.every((s) => s.includes(k)));
  expect({ transition: t.name, dominating: guardKeys(t) }).toEqual({
    transition: t.name,
    dominating: inEvery,
  });
  for (const g of sites.guards) expect(g.dominates).toBe(inEvery.includes(g.guard));
}

/**
 * The contract conformance can rely on to report an unknown from-state once: every transition
 * whose `fromState.values` is `"*"` has exactly one extractor finding
 * `unanalyzable:<behavior>:from-state:<transition>`, and no other transition has one.
 */
export function expectOneUnanalyzablePerUnknownFrom(result: ExtractResult): void {
  const unknown = (result.model?.transitions ?? [])
    .filter((t) => t.sites?.fromState.values === "*")
    .map((t) => t.name)
    .sort();
  const prefix = `unanalyzable:${result.spec}:from-state:`;
  const reported = result.findings
    .filter((f) => f.id.startsWith(prefix))
    .map((f) => f.id.slice(prefix.length))
    .sort();
  expect(reported).toEqual(unknown);
}
