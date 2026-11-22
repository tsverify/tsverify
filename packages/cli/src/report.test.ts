import type { Finding } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import { dedupeFindings } from "./report";

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
