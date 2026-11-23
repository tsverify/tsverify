import type { StorageFunction, StorageRole } from "@tsverify/ir";
import { z } from "zod";

/**
 * The `*.behavior.yaml` v1 format: the single source of truth (docs/behavior-format.md is its human
 * reference). It validates *shape* only. Defaults are applied by `normalize.ts`, and cross-references
 * (states, actors, guards, rule names) are checked by `validate.ts`.
 */

export const TRUST_LEVELS = ["untrusted", "authenticated", "signed-webhook", "internal"] as const;
export const EFFECT_MULTIPLICITIES = ["exactly-once", "at-least-once", "idempotent"] as const;
export const PERSISTENCE_KINDS = ["assign", "prisma", "drizzle", "memory"] as const;
/** `bindings.storage: <preset>`: the built-in storage styles. */
export const STORAGE_PRESETS = ["assign", "prisma", "memory"] as const;
export const STORAGE_ROLES = ["key", "entity", "patch", "from", "to", "callback", "_"] as const;
export const UPDATE_RETURNS = ["changed", "count", "entity", "throws"] as const;
export const RULE_KINDS = ["always", "never", "eventually"] as const;

// The format's roles and returns are exactly the IR's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _roles: Same<(typeof STORAGE_ROLES)[number], StorageRole> = true;
const _returns: Same<
  (typeof UPDATE_RETURNS)[number],
  NonNullable<StorageFunction["returns"]>
> = true;
void _roles;
void _returns;

const DURATION = /^\d+[smhd]$/;

const name = z.string().min(1);
const nameOrList = (what: string) =>
  z.union([name, z.array(name)]).describe(`${what}, or a list of them`);
const guards = nameOrList("A guard such as `owner` or `role(admin)`");

const effect = z
  .union([
    name.describe("Effect name; multiplicity defaults to exactly-once"),
    z
      .record(name, z.enum(EFFECT_MULTIPLICITIES))
      .refine((m) => Object.keys(m).length === 1, {
        error: "must have exactly one key, written `- name: multiplicity`",
      })
      .meta({ minProperties: 1, maxProperties: 1 })
      .describe("`{ name: multiplicity }`"),
  ])
  .describe("An effect performed by the transition, e.g. `stripe.refund`");

const entity = z
  .strictObject({
    name: name.describe("Entity name, e.g. `Order`"),
    state: name.describe("Code field that holds the state, e.g. `status`"),
    states: z.array(name).min(1).describe("Every state the entity can be in (unique)"),
    initial: name.describe("State of a newly created entity"),
    terminal: z.array(name).optional().describe("States with no outgoing transitions"),
  })
  .describe("The stateful entity this behavior describes");

const actor = z
  .strictObject({
    trust: z.enum(TRUST_LEVELS),
    requires: guards.optional().describe("Guards implied for every transition this actor performs"),
  })
  .describe("Who can trigger transitions");

const transition = z
  .strictObject({
    from: nameOrList('Source state (`"*"` = any state)'),
    to: name.describe("Target state"),
    by: nameOrList("Actor allowed to perform the transition"),
    requires: guards.optional(),
    effects: z.array(effect).optional(),
    atomic: z
      .boolean()
      .optional()
      .describe("The state check and the write are one indivisible step (default false)"),
    idempotent: z
      .boolean()
      .optional()
      .describe("The triggering event may be delivered more than once (default false)"),
    after: z
      .string()
      .regex(DURATION, { error: "must be a duration such as 30m, 2h or 7d" })
      .optional()
      .describe("Informational timer, e.g. `30m`"),
    impl: z.string().optional().describe("Implementing symbol: `path/to/file.ts#symbol`"),
  })
  .describe("A state change");

/** YAML reads a bare `true` / `false` as a boolean; both are valid expressions. */
const ruleExpr = z.union([z.string(), z.boolean()]);

const rule = z
  .strictObject({
    name: name.describe("Human-readable rule name (unique)"),
    always: ruleExpr.optional().describe("Expression that holds in every reachable state"),
    never: ruleExpr.optional().describe("Expression that holds in no reachable state"),
    eventually: ruleExpr
      .optional()
      .describe("From every reachable state, a state satisfying the expression is reachable"),
  })
  .superRefine((r, ctx) => {
    const kinds = RULE_KINDS.filter((k) => r[k] !== undefined);
    if (kinds.length === 0) {
      ctx.addIssue({ code: "custom", message: "must have one of always, never, eventually" });
    }
    for (const extra of kinds.slice(1)) {
      ctx.addIssue({
        code: "custom",
        path: [extra],
        message: `is not allowed together with "${kinds[0]}" (a rule has exactly one of always, never, eventually)`,
      });
    }
  })
  .meta({ oneOf: RULE_KINDS.map((k) => ({ required: [k] })) });

const positiveInt = z.int().min(1);

const concurrency = z
  .strictObject({
    default: positiveInt.optional().describe("Invocations explored per transition (default 2)"),
    max_parallel: z
      .record(name, positiveInt)
      .optional()
      .describe("Per-transition override of `default`"),
  })
  .describe("Bounds for the model checker");

const storageRoles = z
  .array(
    z
      .enum(STORAGE_ROLES)
      .describe(
        "`key`, `entity`, `patch` (some fields), `from` (state or states), `to` (state), `callback`, or `_` (ignored)",
      ),
  )
  .describe("Role of each positional argument");

const storageRef = z.string().describe("The app's function: `path/to/file.ts#symbol`");

/** One storage function: `path#symbol`, a long form, or a list of either. */
const storageFunctions = (what: string, defaults: string) => {
  const longForm = z
    .strictObject({
      fn: storageRef,
      args: storageRoles
        .optional()
        .describe(`Role of each positional argument (default ${defaults})`),
    })
    .describe(`${what}, with the role of each argument`);
  const item = z.union([storageRef, longForm]);
  return z
    .union([item, z.array(item)])
    .optional()
    .describe(`${what}, or a list of them`);
};

const updateFunctions = (() => {
  const what = "Conditional save: checks the state and saves in one step";
  const longForm = z
    .strictObject({
      fn: storageRef,
      args: storageRoles
        .optional()
        .describe(
          "Role of each positional argument (default [key, from, to], without the roles a fixed `from` / `to` replaces)",
        ),
      returns: z
        .enum(UPDATE_RETURNS)
        .optional()
        .describe(
          "What it returns: `changed` (true, or false when the state check fails; the default), `count` (1 or 0), `entity` (the updated entity, or undefined), `throws` (throws when the check fails)",
        ),
      from: nameOrList("Fixed from-state, when no argument has the `from` role").optional(),
      to: name.optional().describe("Fixed target state, when no argument has the `to` role"),
    })
    .describe(`${what}, with the role of each argument`);
  const item = z.union([storageRef, longForm]);
  return z
    .union([item, z.array(item)])
    .optional()
    .describe(`${what}, or a list of them`);
})();

const storage = z
  .union([
    z.enum(STORAGE_PRESETS).describe("A built-in storage style (same meaning as `persistence:`)"),
    z
      .strictObject({
        key: name.optional().describe("The entity's key field (default `id`)"),
        read: storageFunctions("Function that loads one entity by key", "[key]"),
        save: storageFunctions("Function that persists an entity", "[entity]"),
        update: updateFunctions,
        atomic: storageFunctions(
          "Function that runs its callback as one indivisible step (declared, not proven)",
          "[callback]",
        ),
      })
      .describe("The app's own storage functions; at least one read, save or update"),
  ])
  .describe(
    "How the entity is stored: a preset (assign, prisma, memory), or the app's own read, save, update and atomic functions",
  );

const bindings = z
  .strictObject({
    persistence: z
      .enum(PERSISTENCE_KINDS)
      .optional()
      .describe(
        "Alias of the preset form of `storage` (kept for existing specs); omitted means auto-detected",
      ),
    storage: storage.optional(),
    clients: z
      .record(
        name,
        z.strictObject({
          module: name.describe("Module path, e.g. `src/payments/stripe.ts`"),
          export: name.describe("Exported binding, e.g. `stripe`"),
        }),
      )
      .optional(),
    guards: z
      .record(name, z.string())
      .optional()
      .describe("Guard (canonical form) → `path#symbol` or `path#symbol(args)`"),
    effects: z
      .record(name, z.string())
      .optional()
      .describe("Effect name → code call path, e.g. `stripe.refunds.create`"),
  })
  .describe("Links from spec names to code");

const fixtures = z
  .strictObject({
    entity: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Fields of a seeded entity, apart from the state field"),
    actors: z
      .record(name, z.unknown())
      .optional()
      .describe("Value per actor, passed where the impl takes an actor"),
    args: z
      .record(name, z.array(z.unknown()))
      .optional()
      .describe('Per-transition argument list; "$id" and "$actor" are substituted'),
  })
  .describe("Test fixtures for generated tests");

export const specSchema = z
  .strictObject({
    behavior: name.describe("Behavior name"),
    summary: z.string().optional(),
    enforced: z
      .boolean()
      .optional()
      .describe(
        "Marks the spec as one CI should block on (default false). tsverify itself never acts on it: it is reported in --format json|sarif and selected with --enforced-only",
      ),
    kind: z.literal("entity").optional().describe("Only `entity` in v1 (default)"),
    entity,
    actors: z.record(name, actor),
    transitions: z.record(name, transition),
    rules: z.array(rule).optional(),
    concurrency: concurrency.optional(),
    bindings: bindings.optional(),
    fixtures: fixtures.optional(),
  })
  .meta({
    title: "tsverify behavior spec (v1)",
    description: "A `*.behavior.yaml` file. See docs/behavior-format.md.",
  });

export type SpecInput = z.infer<typeof specSchema>;
export type TransitionInput = z.infer<typeof transition>;
export type RuleInput = z.infer<typeof rule>;
