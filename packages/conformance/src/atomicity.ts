import type { Finding } from "@tsv/ir";
import { type Pairing, pairingFinding } from "./finding";

/**
 * `t.atomic` requires the read that the state check uses and the write to share one atomic
 * scope (`code.atomic`, per `ModelOrigin`). `codeAt` is the read, where the race window opens,
 * or the write when no read was found. A spec with `atomic: false` accepts either.
 */
export function checkAtomicity(p: Pairing): Finding[] {
  const { t, code, sites } = p;
  if (!t.atomic || code.atomic) return [];
  const read = sites.read === undefined ? "the entity" : `the entity (${sites.read.gate})`;
  return [
    pairingFinding(p, {
      category: "non-atomic",
      severity: "error",
      message:
        `${t.name}: ${sites.function.name} reads ${read} and writes ${t.to} outside one ` +
        "atomic scope; the spec says atomic.",
      hint: "Wrap the read and write in one transaction or use a conditional update.",
      codeAt: sites.read?.at ?? sites.write,
    }),
  ];
}
