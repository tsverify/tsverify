import type { SourceLocation } from "./location";
import type { BehaviorModel } from "./model";

/**
 * A code model names a spec transition's second, third, … write of its `to` `t~2`, `t~3`
 * (`ModelOrigin`): an internal name, for ids and traces. Messages name the spec transition and
 * where the write is instead.
 */
const SUFFIX = /~\d+$/;

/** `cancel~2` → `cancel`; any other name unchanged. */
export function specTransitionName(name: string): string {
  return name.replace(SUFFIX, "");
}

/** Whether `name` is a code model's `t~N` name. */
export function isNumberedWrite(name: string): boolean {
  return SUFFIX.test(name);
}

/** `src/orders/cancel.ts:42` as a message shows it: `cancel.ts:42`. */
export function shortLocation(at: SourceLocation): string {
  return `${at.file.slice(at.file.lastIndexOf("/") + 1)}:${at.line}`;
}

/**
 * How a message names transition `name` of `model`: a code model's `cancel~2` is
 * `cancel (its write at cancel.ts:42)`; every other name is itself.
 */
export function transitionLabel(model: BehaviorModel, name: string): string {
  if (!isNumberedWrite(name)) return name;
  const t = model.transitions.find((x) => x.name === name);
  const at = t?.sites?.write ?? t?.at;
  const base = specTransitionName(name);
  return at === undefined ? base : `${base} (its write at ${shortLocation(at)})`;
}
