import type { BehaviorModel, Transition } from "@tsverify/ir";

/**
 * The function a code transition is atomic through **by declaration**: its atomic scope is a
 * named `bindings.storage.atomic` function (`AtomicScope.kind: "declared"`), which tsverify
 * trusts and does not check inside. `withTransaction` for gate `storage.withTransaction`;
 * undefined for any other transition (spec models have no scopes).
 */
export function declaredAtomicBy(t: Transition): string | undefined {
  const scope = t.sites?.atomic;
  if (!t.atomic || scope?.kind !== "declared") return undefined;
  const gate = scope.gate ?? "";
  return gate.startsWith("storage.") ? gate.slice("storage.".length) : gate;
}

/** The code transitions linked to a spec transition that are atomic only as declared, by name. */
export function declaredAtomicTransitions(
  code: BehaviorModel,
): { transition: string; by: string }[] {
  const out: { transition: string; by: string }[] = [];
  for (const t of code.transitions) {
    const by = declaredAtomicBy(t);
    if (by !== undefined && t.sites?.specTransition === t.name)
      out.push({ transition: t.name, by });
  }
  return out;
}

/** `atomic, as declared by \`withTransaction\``: the wording every output uses. */
export function declaredAtomicText(by: string): string {
  return `atomic, as declared by \`${by}\``;
}
