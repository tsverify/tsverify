import { compareStrings, type Finding } from "@tsv/ir";
import { earliest, type Pairing, pairingFinding } from "./finding";

function uniqueSorted(names: string[]): string[] {
  return [...new Set(names)].sort(compareStrings);
}

/**
 * Compares the effect names declared on `t` with those the primary write's code calls
 * (`code.effects`). A called name that is neither a `bindings.effects` key nor declared on any
 * spec transition is an unmapped gate (e.g. `stripe.charges.create`), and the message says so.
 * Effects on linked writes to other states are not counted: those writes are already
 * `undeclared-transition`.
 *
 * `specAt`: an undeclared effect points at its `bindings.effects` entry (when mapped), a missing
 * one at its declaration under `t.effects`; otherwise both fall back to `t.at`.
 */
export function checkEffects(p: Pairing): Finding[] {
  const { spec, t, code, sites } = p;
  const entry = t.impl === undefined ? sites.function.name : t.impl.symbol;
  const declared = uniqueSorted(t.effects.map((e) => e.name));
  const called = uniqueSorted(code.effects.map((e) => e.name));
  const known = new Set([
    ...Object.keys(spec.bindings.effects),
    ...spec.transitions.flatMap((s) => s.effects.map((e) => e.name)),
  ]);
  const gateOf = (name: string) => spec.bindings.effects[name] ?? name;
  const findings: Finding[] = [];

  for (const name of called) {
    if (declared.includes(name)) continue;
    const callSites = sites.effects.filter((e) => e.effect === name);
    const at = earliest(callSites.map((e) => e.at));
    const gate = callSites[0]?.gate ?? gateOf(name);
    const unmapped = !known.has(name);
    const binding = spec.bindings.effectsAt?.[name];
    findings.push(
      pairingFinding(p, {
        category: "undeclared-effect",
        severity: "error",
        subject: name,
        message: unmapped
          ? `${t.name}: ${entry} calls ${name}, a gate no spec effect maps to (not in bindings.effects).`
          : `${t.name}: ${entry} calls ${name}${gate === name ? "" : ` (${gate})`}, which the spec does not declare for ${t.name}.`,
        hint: unmapped
          ? `Declare the effect on ${t.name} and map it to ${name} in bindings.effects, or remove the call.`
          : `Declare ${name} under ${t.name}.effects, or remove the call.`,
        ...(binding === undefined ? {} : { specAt: binding }),
        codeAt: at ?? sites.write,
      }),
    );
  }

  for (const name of declared) {
    if (called.includes(name)) continue;
    const gate = gateOf(name);
    const declaration = t.effects.find((e) => e.name === name)?.at;
    findings.push(
      pairingFinding(p, {
        category: "missing-effect",
        severity: "error",
        subject: name,
        message: `${t.name}: ${entry} never calls ${name}${gate === name ? "" : ` (${gate})`} when it writes ${t.to}.`,
        hint: `Call ${gate} after the write in ${entry}, or remove ${name} from ${t.name}.effects.`,
        ...(declaration === undefined ? {} : { specAt: declaration }),
        codeAt: sites.write,
      }),
    );
  }
  return findings;
}
