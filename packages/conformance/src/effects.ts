import { compareStrings, type Finding, type SourceLocation } from "@tsverify/ir";
import { earliest, type Pairing, pairingFinding } from "./finding";

/** The client an effect gate calls: `queue` for `queue.acknowledgeMessage`, `notify` for `notify`. */
function clientOfGate(gate: string): string {
  const dot = gate.indexOf(".");
  return dot < 0 ? gate : gate.slice(0, dot);
}

/**
 * The call site to point at: the first one in the impl's file, else in the writing function's
 * file, else the first one anywhere. A helper in another file may make the same call, and a
 * file that sorts first (`batch.ts` before `refund.ts`) shouldn't win over the impl's own.
 */
function nearest(
  locations: SourceLocation[],
  files: readonly (string | undefined)[],
): SourceLocation | undefined {
  for (const file of files) {
    if (file === undefined) continue;
    const own = locations.filter((l) => l.file === file.replace(/^\.\//, ""));
    if (own.length > 0) return earliest(own);
  }
  return earliest(locations);
}

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
 * `specAt`: a missing effect points at its declaration under `t.effects`. An undeclared one points
 * at `t.at`, where the fix (declaring it) goes; its `bindings.effects` entry only names the gate.
 *
 * A declared effect on a client that no call in the project resolves to (`uncalledClients`, the
 * extractor's "bound but never called" warning) can't be checked: the code model has it as
 * specified, and it is a `missing-effect` **warning** that says tsverify couldn't confirm the
 * call, caused by that warning, instead of an error saying the code never makes it.
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
    const at = nearest(
      callSites.map((e) => e.at),
      [t.impl?.file, sites.function.file],
    );
    const gate = callSites[0]?.gate ?? gateOf(name);
    const unmapped = !known.has(name);
    findings.push(
      pairingFinding(p, {
        category: "undeclared-effect",
        severity: "error",
        subject: name,
        message: unmapped
          ? `${t.name}: ${entry} calls ${name}, a gate no spec effect maps to (not in bindings.effects).`
          : `${t.name}: ${entry} calls ${name}${gate === name ? "" : ` (${gate})`}, which the spec does not declare for ${t.name}.`,
        hint: unmapped
          ? `Declare the effect on ${t.name} and map it to ${name} in bindings.effects, list ${gate.slice(clientOfGate(gate).length + 1) || gate} under bindings.clients.${clientOfGate(gate)}.reads if it only reads, or remove the call.`
          : `Declare ${name} under ${t.name}.effects, or remove the call.`,
        codeAt: at ?? sites.write,
      }),
    );
  }

  for (const name of declared) {
    const gate = gateOf(name);
    const declaration = t.effects.find((e) => e.name === name)?.at;
    const client = clientOfGate(gate);
    const unseen = p.uncalledClients?.[client];
    if (unseen !== undefined) {
      const finding = pairingFinding(p, {
        category: "missing-effect",
        severity: "warning",
        subject: name,
        message: `${t.name}: couldn't confirm that ${entry} calls ${name}${gate === name ? "" : ` (${gate})`} when it writes ${t.to}: no call in the project resolves to client ${client}, so tsverify can't see its calls.`,
        hint: `Fix bindings.clients.${client} (see the warning on it). Until then ${name} is taken as specified.`,
        ...(declaration === undefined ? {} : { specAt: declaration }),
        codeAt: sites.write,
      });
      finding.causedBy = [unseen];
      findings.push(finding);
      continue;
    }
    if (called.includes(name)) continue;
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
