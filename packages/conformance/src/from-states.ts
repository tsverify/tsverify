import type { Finding, SourceLocation, Transition } from "@tsverify/ir";
import { formatStates, type Pairing, pairingFinding } from "./finding";

/** `is 'paid'` / `is one of {draft, paid}`. */
function isIn(states: string[]): string {
  return states.length === 1 ? `is '${states[0]}'` : `is one of ${formatStates(states)}`;
}

/**
 * The spec location of `t.from` item `state`, or of the first item when `state` is not listed
 * (or omitted). Undefined for `from: "*"` or without per-item locations (callers fall back to `t.at`).
 */
function fromItemAt(t: Transition, state?: string): SourceLocation | undefined {
  if (t.from === "*") return undefined;
  const i = state === undefined ? 0 : t.from.indexOf(state);
  return t.fromAt?.[Math.max(i, 0)];
}

/**
 * Compares the narrowed from-states at the write with `t.from`.
 *
 * A spec `from: "*"` (or a list naming every entity state) allows any source state, so an
 * unconstrained write conforms to it; a code from-set is then compared with `entity.states`.
 * Extra and missing states can both occur (incomparable sets): each gets its own finding, with
 * the states as the id subject. A mismatch's `specAt` is the `from` item of the first missing
 * state, or the first `from` item for extra states; an unconstrained write's is the first `from`
 * item. An unknown from-state (`values: "*"`, e.g. a `string`-typed field) gives no finding here:
 * the extractor reports it once, as `unanalyzable`.
 */
export function checkFromStates(p: Pairing): Finding[] {
  const { spec, t, code, sites } = p;
  const field = spec.entity.stateField;
  const specFrom = t.from === "*" ? spec.entity.states : t.from;
  const specAllowsAny = spec.entity.states.every((s) => specFrom.includes(s));

  // The extractor already reported this cause (`unanalyzable:<behavior>:from-state:<t>`).
  if (sites.fromState.values === "*") return [];
  const codeFrom = code.from;
  if (codeFrom === "*" || sites.fromState.unconstrained) {
    if (specAllowsAny) return [];
    const reason = sites.fromState.reason ?? `${field} is not checked before the write`;
    const specAt = fromItemAt(t);
    return [
      pairingFinding(p, {
        category: "from-state-unconstrained",
        severity: "error",
        message:
          `${t.name}: ${sites.function.name} writes ${t.to} from any state (${reason}); ` +
          `the spec allows only ${formatStates(specFrom)}.`,
        hint: `Check that ${field} ${isIn(specFrom)} before the write, inside the same atomic scope.`,
        ...(specAt === undefined ? {} : { specAt }),
        codeAt: sites.write,
      }),
    ];
  }

  const findings: Finding[] = [];
  const extra = codeFrom.filter((s) => !specFrom.includes(s));
  const missing = specFrom.filter((s) => !codeFrom.includes(s));
  if (extra.length > 0) {
    const specAt = fromItemAt(t);
    findings.push(
      pairingFinding(p, {
        category: "from-state-mismatch",
        severity: "error",
        subject: extra.join(","),
        message:
          `${t.name}: ${sites.function.name} also writes ${t.to} from ${formatStates(extra)}, ` +
          `which the spec does not allow (from: ${formatStates(specFrom)}).`,
        hint: `Tighten the check before the write to ${field} ${isIn(specFrom)}, or add ${formatStates(extra)} to ${t.name}.from.`,
        ...(specAt === undefined ? {} : { specAt }),
        codeAt: sites.write,
      }),
    );
  }
  if (missing.length > 0) {
    const specAt = fromItemAt(t, missing[0]);
    findings.push(
      pairingFinding(p, {
        category: "from-state-mismatch",
        severity: "warning",
        subject: missing.join(","),
        message:
          `${t.name}: ${sites.function.name} only writes ${t.to} from ${formatStates(codeFrom)}; ` +
          `the spec also allows ${formatStates(missing)}.`,
        hint: `Remove ${formatStates(missing)} from ${t.name}.from, or let the code accept it.`,
        ...(specAt === undefined ? {} : { specAt }),
        codeAt: sites.write,
      }),
    );
  }
  return findings;
}
