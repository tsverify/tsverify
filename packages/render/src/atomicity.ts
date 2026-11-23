import { type BehaviorModel, compareStrings, type Transition } from "@tsverify/ir";

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

/**
 * The spec transitions atomic only as declared, by name: those whose every write of its `to` in
 * the code (the code transitions `t`, `t~2`, … linked to it) runs inside a declared atomic
 * function, with that function (one entry per function when they differ). A transition with one
 * such write and another that isn't (a `non-atomic` finding) is not listed: it is not atomic.
 */
export function declaredAtomicTransitions(
  code: BehaviorModel,
): { transition: string; by: string }[] {
  const writes = new Map<string, Transition[]>();
  for (const t of code.transitions) {
    const name = t.sites?.specTransition;
    if (name === undefined || (t.name !== name && !t.name.startsWith(`${name}~`))) continue;
    writes.set(name, [...(writes.get(name) ?? []), t]);
  }
  const out: { transition: string; by: string }[] = [];
  for (const [transition, list] of writes) {
    const by = list.map(declaredAtomicBy);
    if (by.some((b) => b === undefined)) continue;
    for (const b of new Set(by as string[])) out.push({ transition, by: b });
  }
  return out.sort(
    (a, b) => compareStrings(a.transition, b.transition) || compareStrings(a.by, b.by),
  );
}

/** `atomic, as declared by \`withTransaction\``: the wording every output uses. */
export function declaredAtomicText(by: string): string {
  return `atomic, as declared by \`${by}\``;
}
