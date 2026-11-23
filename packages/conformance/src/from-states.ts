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
 * Extra states (an error: this write accepts a state the spec doesn't allow) are reported per
 * write, with the states as the id subject, at the first `from` item; an unconstrained write's is
 * at the first `from` item too. Missing states are not decided per write: an impl can reach
 * several writes of `t.to`, each for some of the from-states (`checkMissingFromStates`). An
 * unknown from-state (`values: "*"`, e.g. a `string`-typed field) gives no finding here: the
 * extractor reports it once, as `unanalyzable`.
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
  return findings;
}

/**
 * The spec's from-states of `t` that none of its writes of `t.to` accepts (the code is stricter):
 * one `from-state-mismatch` **warning** for the transition, with the states as the id subject, at
 * the `from` item of the first one. `pairings` are all of `t`'s primary writes: when the impl
 * reaches several (`t`, `t~2`, …, e.g. one per code path), the from-states they accept together
 * are compared, since each path may handle some of them. A write whose from-state is unknown
 * (`*`) or unconstrained accepts every state, so nothing is missing.
 */
export function checkMissingFromStates(pairings: readonly Pairing[]): Finding[] {
  const [first] = pairings;
  if (first === undefined) return [];
  const { spec, t } = first;
  const specFrom = t.from === "*" ? spec.entity.states : t.from;
  const accepted = new Set<string>();
  for (const { code, sites } of pairings) {
    if (code.from === "*" || sites.fromState.values === "*" || sites.fromState.unconstrained) {
      return [];
    }
    for (const s of code.from) accepted.add(s);
  }
  const missing = specFrom.filter((s) => !accepted.has(s));
  if (missing.length === 0) return [];
  const codeFrom = specFrom.filter((s) => accepted.has(s));
  const extraFrom = [...accepted].filter((s) => !specFrom.includes(s));
  const from = formatStates([...codeFrom, ...extraFrom]);
  const functions = [...new Set(pairings.map((p) => p.sites.function.name))];
  const who =
    pairings.length === 1
      ? `${first.sites.function.name} only writes ${t.to}`
      : `its ${pairings.length} writes of ${t.to} (in ${functions.join(", ")}) together only write it`;
  const specAt = fromItemAt(t, missing[0]);
  return [
    pairingFinding(
      { ...first, code: { ...first.code, name: t.name } },
      {
        category: "from-state-mismatch",
        severity: "warning",
        subject: missing.join(","),
        message: `${t.name}: ${who} from ${from}; the spec also allows ${formatStates(missing)}.`,
        hint: `Remove ${formatStates(missing)} from ${t.name}.from, or let the code accept it.`,
        ...(specAt === undefined ? {} : { specAt }),
        codeAt: first.sites.write,
      },
    ),
  ];
}
