import type { SourceLocation } from "./location";

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

/**
 * Rule expression AST. Produced by `@tsverify/spec` (syntax), evaluated by `@tsverify/checker`.
 *
 * Grammar (precedence low → high): implies, or, and, not, atom
 *   atom := status == NAME | status != NAME | status in [NAME, …]
 *         | count(effect NAME) CMP INT | true | false | ( expr )
 */
export type Expr =
  | { type: "status-cmp"; op: "==" | "!="; value: string }
  | { type: "status-in"; values: string[] }
  | { type: "effect-count"; effect: string; op: CmpOp; value: number }
  | { type: "bool"; value: boolean }
  | { type: "not"; expr: Expr }
  | { type: "and" | "or" | "implies"; left: Expr; right: Expr };

/**
 * - always:     expr holds in every reachable state
 * - never:      expr holds in no reachable state
 * - eventually: from every reachable state, a state satisfying expr is reachable (AG EF)
 */
export type RuleKind = "always" | "never" | "eventually";

export interface Rule {
  name: string;
  kind: RuleKind;
  expr: Expr;
  /** The expression exactly as written in the spec. */
  source: string;
  at?: SourceLocation;
}
