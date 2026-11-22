import {
  type BehaviorModel,
  type CallSite,
  type CodeSites,
  compareStrings,
  type FromState,
  type GuardRef,
  type InvocationShape,
  parseGuardRef,
  type SourceLocation,
  type Transition,
} from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";

/**
 * Test-only spec and code models for the Order app (`examples/orders-app`). The clean code
 * model is what the extractor should build from the clean app; each variant applies a small
 * mutation mirroring one seeded bug in `examples/orders-app/variants`. Locations are the real
 * positions in those files, so findings read like the ones `tsverify check` prints.
 */

const SPEC_FILE = "src/orders/order.behavior.yaml";

/** `[line, column]`, 1-based. */
type Pos = [number, number];

/**
 * Start positions in `examples/orders-app/src/orders/order.behavior.yaml` of each transition
 * key, its `from` and `by` item, its `requires` items and its effect declarations.
 */
const SPEC_POSITIONS: Record<
  string,
  { at: Pos; from: Pos; by: Pos; requires?: Pos[]; effects?: Pos[] }
> = {
  checkout: { at: [19, 3], from: [20, 11], by: [22, 9], requires: [[23, 16]] },
  payment_succeeded: { at: [27, 3], from: [28, 11], by: [30, 9], effects: [[34, 9]] },
  expire: { at: [37, 3], from: [38, 11], by: [40, 9] },
  ship: { at: [45, 3], from: [46, 11], by: [48, 9] },
  refund: { at: [52, 3], from: [53, 11], by: [55, 9], effects: [[58, 9]] },
};

function specLoc([line, column]: Pos): SourceLocation {
  return { file: SPEC_FILE, line, column };
}

/**
 * `orderModel()` plus the file and the (start) locations the spec parser would attach: each
 * transition, its `from` / `by` / `requires` items and effect declarations, the admin actor's
 * `requires` item and each `bindings.effects` entry.
 */
export function specModel(): BehaviorModel {
  const model = orderModel();
  model.file = SPEC_FILE;
  for (const t of model.transitions) {
    const pos = SPEC_POSITIONS[t.name];
    if (pos === undefined) continue;
    t.at = specLoc(pos.at);
    t.fromAt = [specLoc(pos.from)];
    t.byAt = [specLoc(pos.by)];
    t.requires.forEach((g, i) => {
      const at = pos.requires?.[i];
      if (at !== undefined) g.at = specLoc(at);
    });
    t.effects.forEach((e, i) => {
      const at = pos.effects?.[i];
      if (at !== undefined) e.at = specLoc(at);
    });
  }
  for (const g of model.actors.admin?.requires ?? []) g.at = specLoc([14, 44]);
  model.bindings.effectsAt = {
    "email.receipt": specLoc([85, 5]),
    "stripe.refund": specLoc([84, 5]),
  };
  return model;
}

/** One extracted state write, in a compact form; `buildCodeModel` derives the `Transition`. */
export interface Write {
  name: string;
  specTransition?: string;
  to: string;
  fromState: FromState;
  file: string;
  fn: string;
  fnAt: Pos;
  write: Pos;
  /** Read and commit call sites; their gates are `db.orders.get` / `db.orders.save`. */
  read?: Pos;
  commit?: Pos;
  /** A `db.transaction` scope around the read and the write. */
  transaction?: Pos;
  guards: { guard: string; at: Pos; dominates: boolean }[];
  effects: { effect: string; gate: string; at: Pos }[];
  /** Entity id and actor parameters of the impl, as `[param, ...path]`. */
  entityId: [number, ...string[]];
  actor?: [number, ...string[]];
}

function loc(file: string, [line, column]: Pos): SourceLocation {
  return { file, line, column };
}

function callSite(file: string, gate: string, at: Pos, occurrence = 0): CallSite {
  const dot = gate.indexOf(".");
  return {
    at: loc(file, at),
    client: gate.slice(0, dot),
    path: gate.slice(dot + 1),
    gate,
    occurrence,
  };
}

function guardRef(raw: string): GuardRef {
  const ref = parseGuardRef(raw);
  if (ref === undefined) throw new Error(`bad guard ref ${raw}`);
  return ref;
}

function from(state: string[]): FromState {
  return { values: state, unconstrained: false };
}

/** Follows the conventions documented on `ModelOrigin` in `@tsverify/ir`. */
function buildTransition(spec: BehaviorModel, w: Write): Transition {
  const linked = spec.transitions.find((t) => t.name === w.specTransition);
  const specEffects = spec.transitions.flatMap((t) => t.effects);
  const sites: CodeSites = {
    persistence: "assign",
    write: loc(w.file, w.write),
    function: { file: w.file, name: w.fn, at: loc(w.file, w.fnAt) },
    ...(w.specTransition === undefined ? {} : { specTransition: w.specTransition }),
    fromState: w.fromState,
    ...(w.read === undefined ? {} : { read: callSite(w.file, "db.orders.get", w.read) }),
    ...(w.commit === undefined ? {} : { commit: callSite(w.file, "db.orders.save", w.commit) }),
    ...(w.transaction === undefined
      ? {}
      : {
          atomic: { kind: "transaction", at: loc(w.file, w.transaction), gate: "db.transaction" },
        }),
    guards: w.guards.map((g) => ({
      guard: g.guard,
      at: loc(w.file, g.at),
      dominates: g.dominates,
    })),
    effects: w.effects.map((e) => ({ ...callSite(w.file, e.gate, e.at), effect: e.effect })),
    ...(linked?.impl === undefined
      ? {}
      : {
          invocation: {
            impl: linked.impl,
            entityId: { param: w.entityId[0], path: w.entityId.slice(1) as string[] },
            ...(w.actor === undefined
              ? {}
              : { actor: { param: w.actor[0], path: w.actor.slice(1) as string[] } }),
          } satisfies InvocationShape,
        }),
    storage: { client: "db", collection: "orders", key: "id" },
  };
  return {
    name: w.name,
    from: w.fromState.values,
    to: w.to,
    by: linked?.by ?? [],
    requires: w.guards.filter((g) => g.dominates).map((g) => guardRef(g.guard)),
    effects: w.effects.map((e) => ({
      name: e.effect,
      multiplicity:
        specEffects.find((d) => d.name === e.effect)?.multiplicity ?? ("at-least-once" as const),
    })),
    atomic: sites.atomic !== undefined,
    idempotent: linked?.idempotent ?? false,
    ...(linked?.impl === undefined ? {} : { impl: linked.impl }),
    sites,
  };
}

/** The code model the extractor builds from `spec` and these writes. */
export function buildCodeModel(spec: BehaviorModel, writes: Write[]): BehaviorModel {
  const model = structuredClone(spec);
  const transitions = writes
    .map((w) => buildTransition(spec, w))
    .sort((a, b) => compareStrings(a.name, b.name));
  return {
    ...model,
    origin: "code",
    transitions,
    concurrency: Object.fromEntries(
      writes.map((w) => [
        w.name,
        (w.specTransition === undefined ? undefined : spec.concurrency[w.specTransition]) ?? 2,
      ]),
    ),
  };
}

/** The writes in the clean `examples/orders-app/src`. */
export function cleanWrites(): Write[] {
  return [
    {
      name: "checkout",
      specTransition: "checkout",
      to: "pending_payment",
      fromState: from(["draft"]),
      file: "src/orders/checkout.ts",
      fn: "checkout",
      fnAt: [8, 1],
      transaction: [9, 10],
      read: [10, 25],
      guards: [{ guard: "owner", at: [11, 5], dominates: true }],
      write: [13, 5],
      commit: [14, 11],
      effects: [],
      entityId: [1],
      actor: [0, "actor"],
    },
    {
      name: "expire",
      specTransition: "expire",
      to: "cancelled",
      fromState: from(["pending_payment"]),
      file: "src/jobs/expire-orders.ts",
      fn: "expireOrder",
      fnAt: [9, 1],
      transaction: [10, 10],
      read: [11, 25],
      guards: [],
      write: [13, 5],
      commit: [14, 11],
      effects: [],
      entityId: [0],
    },
    {
      name: "payment_succeeded",
      specTransition: "payment_succeeded",
      to: "paid",
      fromState: from(["pending_payment"]),
      file: "src/payments/webhook.ts",
      fn: "onPaymentSucceeded",
      fnAt: [18, 1],
      transaction: [19, 22],
      read: [20, 25],
      guards: [],
      write: [22, 5],
      commit: [24, 11],
      effects: [{ effect: "email.receipt", gate: "email.send", at: [28, 9] }],
      entityId: [0, "orderId"],
    },
    {
      name: "refund",
      specTransition: "refund",
      to: "refunded",
      fromState: from(["paid"]),
      file: "src/orders/refund.ts",
      fn: "refundOrder",
      fnAt: [11, 1],
      guards: [{ guard: "role(admin)", at: [12, 3], dominates: true }],
      transaction: [13, 24],
      read: [14, 25],
      write: [17, 5],
      commit: [18, 11],
      effects: [{ effect: "stripe.refund", gate: "stripe.refunds.create", at: [21, 10] }],
      entityId: [1],
      actor: [0, "actor"],
    },
    {
      name: "ship",
      specTransition: "ship",
      to: "shipped",
      fromState: from(["paid"]),
      file: "src/admin/orders.ts",
      fn: "shipOrder",
      fnAt: [8, 1],
      guards: [{ guard: "role(admin)", at: [9, 3], dominates: true }],
      transaction: [10, 10],
      read: [11, 25],
      write: [13, 5],
      commit: [14, 11],
      effects: [],
      entityId: [1],
      actor: [0, "actor"],
    },
  ];
}

/** The clean write named `name` (which must exist). */
export function cleanWrite(name: string): Write {
  const write = cleanWrites().find((w) => w.name === name);
  if (write === undefined) throw new Error(`no write ${name}`);
  return write;
}

/** Replaces the write named `name` (which must exist) with `patch(write)`. */
export function patchWrite(writes: Write[], name: string, patch: (w: Write) => Write): Write[] {
  if (!writes.some((w) => w.name === name)) throw new Error(`no write ${name}`);
  return writes.map((w) => (w.name === name ? patch(w) : w));
}

/** Replaces the spec transition named `name` with `patch(t)`. */
export function patchSpec(
  spec: BehaviorModel,
  name: string,
  patch: (t: Transition) => Transition,
): BehaviorModel {
  if (!spec.transitions.some((t) => t.name === name)) throw new Error(`no transition ${name}`);
  return { ...spec, transitions: spec.transitions.map((t) => (t.name === name ? patch(t) : t)) };
}

export interface Case {
  spec: BehaviorModel;
  code: BehaviorModel;
}

export function cleanCase(): Case {
  const spec = specModel();
  return { spec, code: buildCodeModel(spec, cleanWrites()) };
}

function codeCase(writes: Write[]): Case {
  const spec = specModel();
  return { spec, code: buildCodeModel(spec, writes) };
}

/**
 * One case per directory in `examples/orders-app/variants`, mirroring that overlay's change.
 * Positions are those in the overlay file.
 */
export const VARIANT_CASES = {
  /** `reopenOrder` next to `shipOrder`: paid → pending_payment, reached by no impl. */
  "b1-reopen": () =>
    codeCase([
      ...cleanWrites(),
      {
        name: "reopenOrder",
        to: "pending_payment",
        fromState: from(["paid"]),
        file: "src/admin/orders.ts",
        fn: "reopenOrder",
        fnAt: [20, 1],
        guards: [{ guard: "role(admin)", at: [21, 3], dominates: true }],
        transaction: [22, 10],
        read: [23, 25],
        write: [25, 5],
        commit: [26, 11],
        effects: [],
        entityId: [1],
        actor: [0, "actor"],
      },
    ]),
  /** The write moves into the `issueRefund` helper; one call path skips `requireRole`. */
  "b2-guard-bypass": () =>
    codeCase(
      patchWrite(cleanWrites(), "refund", (w) => ({
        ...w,
        fn: "issueRefund",
        fnAt: [25, 1],
        guards: [{ guard: "role(admin)", at: [21, 3], dominates: false }],
        transaction: [26, 24],
        read: [27, 25],
        write: [30, 5],
        commit: [31, 11],
        effects: [{ effect: "stripe.refund", gate: "stripe.refunds.create", at: [34, 10] }],
      })),
    ),
  /** No transaction: read, check, Stripe call, assign, save. */
  "b3-refund-race": () =>
    codeCase(
      patchWrite(cleanWrites(), "refund", (w) => {
        const { transaction: _, ...rest } = w;
        return {
          ...rest,
          fnAt: [8, 1],
          guards: [{ guard: "role(admin)", at: [9, 3], dominates: true }],
          read: [10, 23],
          effects: [{ effect: "stripe.refund", gate: "stripe.refunds.create", at: [13, 24] }],
          write: [14, 3],
          commit: [15, 9],
        };
      }),
    ),
  /** The status check is gone: the transaction always writes paid. */
  "b4-webhook-dup": () =>
    codeCase(
      patchWrite(cleanWrites(), "payment_succeeded", (w) => ({
        ...w,
        fromState: {
          values: "*",
          unconstrained: true,
          reason: "no status check before the write",
        },
        fnAt: [15, 1],
        transaction: [16, 22],
        read: [17, 25],
        write: [18, 5],
        commit: [20, 11],
        effects: [{ effect: "email.receipt", gate: "email.send", at: [23, 9] }],
      })),
    ),
  /** After the commit, a cancelled order with a charge is refunded. */
  "b5-undeclared-effect": () =>
    codeCase(
      patchWrite(cleanWrites(), "expire", (w) => ({
        ...w,
        fnAt: [10, 1],
        transaction: [11, 25],
        read: [12, 25],
        write: [14, 5],
        commit: [15, 11],
        effects: [{ effect: "stripe.refund", gate: "stripe.refunds.create", at: [21, 11] }],
      })),
    ),
  /** The spec drops `atomic` on refund; the code is the clean, atomic code. */
  "b6-spec-race": () => {
    const original = specModel();
    const spec = patchSpec(original, "refund", (t) => ({ ...t, atomic: false }));
    return { spec, code: buildCodeModel(spec, cleanWrites()) };
  },
} satisfies Record<string, () => Case>;

/** The case for variant directory `id`, or undefined when there is none yet. */
export function variantCase(id: string): Case | undefined {
  return Object.hasOwn(VARIANT_CASES, id)
    ? VARIANT_CASES[id as keyof typeof VARIANT_CASES]()
    : undefined;
}

/** A second write in `refundOrder`'s call graph, to `to` (named per the `t->to` convention). */
export function extraRefundWrite(to: string): Write {
  return { ...cleanWrite("refund"), name: `refund->${to}`, to, write: [19, 5], effects: [] };
}

/** Where `refundOrder` (refund's impl) is declared, as the extractor reports it in `implAt`. */
export const REFUND_IMPL_AT: SourceLocation = { file: "src/orders/refund.ts", line: 11, column: 1 };

/** `expire` with `from: [draft, pending_payment]` (on line 38), which the code does not match. */
export function strictExpire(t: Transition): Transition {
  return {
    ...t,
    from: ["draft", "pending_payment"],
    fromAt: [
      { file: SPEC_FILE, line: 38, column: 12 },
      { file: SPEC_FILE, line: 38, column: 19 },
    ],
  };
}

/** Synthetic mutations covering the rules no seeded bug exercises. */
export const MUTATION_CASES = {
  "missing-effect": () =>
    codeCase(patchWrite(cleanWrites(), "payment_succeeded", (w) => ({ ...w, effects: [] }))),
  "unmapped-effect": () =>
    codeCase(
      patchWrite(cleanWrites(), "refund", (w) => ({
        ...w,
        effects: [
          ...w.effects,
          { effect: "stripe.charges.create", gate: "stripe.charges.create", at: [20, 3] },
        ],
      })),
    ),
  "missing-transition": () => {
    const { spec, code } = codeCase(cleanWrites().filter((w) => w.name !== "refund"));
    return { spec, code: { ...code, implAt: { refund: REFUND_IMPL_AT } } };
  },
  "wrong-state": () =>
    codeCase(
      patchWrite(cleanWrites(), "ship", (w) => ({ ...w, name: "ship->refunded", to: "refunded" })),
    ),
  "extra-linked-write": () => codeCase([...cleanWrites(), extraRefundWrite("cancelled")]),
  "undeclared-state": () => codeCase([...cleanWrites(), extraRefundWrite("archived")]),
  "never-guarded": () =>
    codeCase(patchWrite(cleanWrites(), "checkout", (w) => ({ ...w, guards: [] }))),
  "extra-from": () =>
    codeCase(
      patchWrite(cleanWrites(), "checkout", (w) => ({
        ...w,
        fromState: from(["cancelled", "draft"]),
      })),
    ),
  "strict-from": () => {
    const spec = patchSpec(specModel(), "expire", strictExpire);
    return { spec, code: buildCodeModel(spec, cleanWrites()) };
  },
  "no-impl": () => {
    const spec = patchSpec(specModel(), "checkout", ({ impl: _, ...t }) => t);
    const writes = patchWrite(cleanWrites(), "checkout", ({ specTransition: _, ...w }) => w);
    return { spec, code: buildCodeModel(spec, writes) };
  },
} satisfies Record<string, () => Case>;
