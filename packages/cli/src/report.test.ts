import type { Finding } from "@tsverify/ir";
import { describe, expect, it } from "vitest";
import { dedupeFindings, dropSpecRepeats } from "./report";

function finding(id: string, message: string): Finding {
  return { id, category: "unanalyzable", severity: "warning", message };
}

describe("dedupeFindings", () => {
  it("keeps the first finding per id and the original order", () => {
    const findings = [finding("a", "1"), finding("b", "2"), finding("a", "3"), finding("c", "4")];
    expect(dedupeFindings(findings).map((f) => f.message)).toEqual(["1", "2", "4"]);
  });

  it("leaves distinct findings alone", () => {
    const findings = [finding("a", "1"), finding("b", "2")];
    expect(dedupeFindings(findings)).toEqual(findings);
  });
});

describe("dropSpecRepeats", () => {
  const stuck = (category: Finding["category"], model: "spec" | "code", status = "a"): Finding => ({
    id: `${category}:Skel:no-stuck-states`,
    category,
    severity: "error",
    message: `O can get stuck in non-terminal status \`${status}\``,
    trace: {
      behavior: "Skel",
      entity: "O",
      model,
      property: "no-stuck-states",
      kind: "liveness",
      steps: [{ index: 0, state: { status, effects: {}, workers: [] } }],
    },
  });

  it("drops the code model's copy of a spec's own counterexample", () => {
    const findings = [stuck("spec-property", "spec"), stuck("implementation-property", "code")];
    expect(dropSpecRepeats(findings).map((f) => f.category)).toEqual(["spec-property"]);
  });

  it("keeps a code counterexample that differs from the spec's", () => {
    const findings = [
      stuck("spec-property", "spec"),
      stuck("implementation-property", "code", "b"),
    ];
    expect(dropSpecRepeats(findings)).toHaveLength(2);
  });
});
