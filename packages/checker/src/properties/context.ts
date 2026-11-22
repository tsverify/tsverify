import type { BehaviorModel, Finding, FindingCategory, Trace } from "@tsverify/ir";
import type { Layout } from "../encode";

/** Everything a property checker needs to know about the model being checked. */
export interface CheckContext {
  model: BehaviorModel;
  layout: Layout;
  /** `spec-property` for spec models, `implementation-property` for extracted code models. */
  category: FindingCategory;
}

export function checkContext(model: BehaviorModel, layout: Layout): CheckContext {
  return {
    model,
    layout,
    category: model.origin === "spec" ? "spec-property" : "implementation-property",
  };
}

/** Builds the counterexample that ends in state `stateId`. */
export type TraceBuilder = (stateId: number, property: string, kind: Trace["kind"]) => Trace;

export interface FindingsInput {
  trace: TraceBuilder;
  /** false when exploration stopped at the state limit. */
  complete: boolean;
}

/** A property evaluated during exploration. `state` rows are only valid during the callback. */
export interface PropertyChecker {
  onState?(id: number, state: Uint16Array): void;
  onDeadlock?(id: number, state: Uint16Array, budgetLimited: boolean): void;
  findings(input: FindingsInput): Finding[];
}

/**
 * A property finding with the stable id `<category>:<behavior>:<property>`, suffixed with
 * `:<subject>` (a transition, state or effect name) for properties that can fire more than once.
 */
export function propertyFinding(
  ctx: CheckContext,
  property: string,
  subject: string | undefined,
  rest: Omit<Finding, "id" | "category" | "behavior" | "property">,
): Finding {
  const base = `${ctx.category}:${ctx.model.name}:${property}`;
  return {
    id: subject === undefined ? base : `${base}:${subject}`,
    category: ctx.category,
    behavior: ctx.model.name,
    property,
    ...rest,
  };
}
