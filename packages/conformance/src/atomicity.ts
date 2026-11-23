import type { Finding } from "@tsverify/ir";
import { type Pairing, pairingFinding } from "./finding";

/**
 * `t.atomic` requires the read that the state check uses and the write to share one atomic
 * scope (`code.atomic`, per `ModelOrigin`). `codeAt` is the read, where the race window opens,
 * or the write when no read was found. A spec with `atomic: false` accepts either. When the
 * adapter knows why a scoped-looking read and write still race (`sites.atomicNote`, e.g. a
 * Prisma `$transaction` at READ COMMITTED), that reason and its hint replace the generic ones.
 * For `memory` persistence the fix is to keep the check and the write synchronous; for named
 * storage functions (`functions`), a bound atomic function or a conditional save.
 */
export function checkAtomicity(p: Pairing): Finding[] {
  const { t, code, sites } = p;
  if (!t.atomic || code.atomic) return [];
  const read = sites.read === undefined ? "the entity" : `the entity (${sites.read.gate})`;
  const note = sites.atomicNote;
  if (note) {
    return [
      pairingFinding(p, {
        category: "non-atomic",
        severity: "error",
        message: `${t.name}: ${sites.function.name} reads ${read} and writes ${t.to}, but ${note.message}; the spec says atomic.`,
        hint: note.hint,
        codeAt: sites.read?.at ?? sites.write,
      }),
    ];
  }
  return [
    pairingFinding(p, {
      category: "non-atomic",
      severity: "error",
      message:
        `${t.name}: ${sites.function.name} reads ${read} and writes ${t.to} outside one ` +
        "atomic scope; the spec says atomic.",
      hint:
        sites.persistence === "memory"
          ? "Make the check and the write synchronous: no `await`/`yield` between reading the state and writing it."
          : sites.persistence === "functions"
            ? "Run the read and the save inside one `bindings.storage.atomic` function, or save with a conditional save (`bindings.storage.update`) and stop when it saved nothing."
            : "Wrap the read and write in one transaction or use a conditional update.",
      codeAt: sites.read?.at ?? sites.write,
    }),
  ];
}
