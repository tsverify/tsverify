/**
 * The violated property of a counterexample, compiled to code terms for a replay test: effect
 * counts become `effects[<gate>]` (fast-forwarded prefix + calls recorded in the replay) and
 * status checks read the stored entity (`status`). Liveness (`eventually`) and structural
 * properties are not decidable from one finished replay: those replays are inconclusive.
 */
import type { CmpOp, Expr, Finding, Rule } from "@tsv/ir";

export type Evaluation =
  | {
      evaluable: true;
      /** Boolean expression over `status` and `effects` that is true when the property is violated. */
      violated: string;
      /** One line for a comment, e.g. `rule "…" (always: count(effect stripe.refund) <= 1)`. */
      description: string;
      /** Short form for a test name, e.g. `effect-multiplicity stripe.refund`. */
      label: string;
    }
  | { evaluable: false; reason: string; description: string; label: string };

export interface PropertyInput {
  finding: Finding;
  rules: readonly Rule[];
  /** Spec effect name → gate label. */
  gate: (effect: string) => string;
  /** Exactly-once effects declared in the spec (for an effect-multiplicity finding without subject). */
  exactlyOnce: readonly string[];
}

const MULTIPLICITY = "effect-multiplicity";

export function evaluation(input: PropertyInput): Evaluation {
  const { finding, rules, gate } = input;
  const trace = finding.trace;
  const property = trace?.property ?? finding.property ?? "";

  if (property === MULTIPLICITY) {
    const effect = multiplicityEffect(input);
    const label = `${MULTIPLICITY} ${effect ?? "?"}`;
    if (effect === undefined) {
      return {
        evaluable: false,
        reason: "the finding does not name the effect",
        description: MULTIPLICITY,
        label,
      };
    }
    return {
      evaluable: true,
      violated: `!(${count(gate(effect))} <= 1)`,
      description: `${MULTIPLICITY}: exactly-once effect ${effect} fires at most once (count(effect ${effect}) <= 1)`,
      label,
    };
  }

  if (property.startsWith("rule:")) {
    const name = property.slice("rule:".length);
    const label = `rule "${name}"`;
    const rule = rules.find((r) => r.name === name);
    if (rule === undefined) {
      return {
        evaluable: false,
        reason: `the spec has no rule named "${name}"`,
        description: label,
        label,
      };
    }
    const description = `rule "${rule.name}" (${rule.kind}: ${rule.source})`;
    if (rule.kind === "eventually" || trace?.kind === "liveness") {
      return {
        evaluable: false,
        reason: `\`${rule.kind}\` is a liveness property: one finished replay cannot show it is violated`,
        description,
        label,
      };
    }
    const expr = compile(rule.expr, gate);
    return {
      evaluable: true,
      violated: rule.kind === "always" ? `!(${expr})` : expr,
      description,
      label,
    };
  }

  return {
    evaluable: false,
    reason: `the property \`${property}\` is not an effect count or a status check`,
    description: `property ${property}`,
    label: property,
  };
}

/** The effect of an effect-multiplicity finding: its id's subject, else the over-counted effect. */
function multiplicityEffect(input: PropertyInput): string | undefined {
  const { finding, exactlyOnce } = input;
  const marker = `:${MULTIPLICITY}:`;
  const at = finding.id.lastIndexOf(marker);
  if (at !== -1) return finding.id.slice(at + marker.length);
  const last = finding.trace?.steps.at(-1)?.state.effects ?? {};
  return exactlyOnce.find((e) => (last[e] ?? 0) > 1);
}

function count(gate: string): string {
  return `(effects[${JSON.stringify(gate)}] ?? 0)`;
}

const JS_OP: Record<CmpOp, string> = {
  "==": "===",
  "!=": "!==",
  "<": "<",
  "<=": "<=",
  ">": ">",
  ">=": ">=",
};

/** `Expr` → a JavaScript boolean expression over `status` and `effects`. */
export function compile(e: Expr, gate: (effect: string) => string): string {
  const sub = (x: Expr) => {
    const code = compile(x, gate);
    return x.type === "and" || x.type === "or" || x.type === "implies" ? `(${code})` : code;
  };
  switch (e.type) {
    case "status-cmp":
      return `status ${JS_OP[e.op]} ${JSON.stringify(e.value)}`;
    case "status-in":
      return e.values.length === 0
        ? "false"
        : `(${e.values.map((v) => `status === ${JSON.stringify(v)}`).join(" || ")})`;
    case "effect-count":
      return `${count(gate(e.effect))} ${JS_OP[e.op]} ${e.value}`;
    case "bool":
      return String(e.value);
    case "not":
      return `!(${compile(e.expr, gate)})`;
    case "and":
      return `${sub(e.left)} && ${sub(e.right)}`;
    case "or":
      return `${sub(e.left)} || ${sub(e.right)}`;
    case "implies":
      return `!(${compile(e.left, gate)}) || ${sub(e.right)}`;
  }
}
