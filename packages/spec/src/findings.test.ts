import { describe, expect, it } from "vitest";
import { FindingCollector, list, suggest } from "./findings";

const at = (line: number, column: number) => ({ file: "a.yaml", line, column });

describe("FindingCollector", () => {
  it("sorts by position and gives colliding ids a suffix", () => {
    const out = new FindingCollector("a.yaml");
    out.behavior = "B";
    out.error(at(3, 1), "z");
    out.warning(at(1, 5), "w", { transition: "t", hint: "h" });
    out.error(at(3, 1), "a");
    expect(out.hasErrors()).toBe(true);
    expect(out.finish()).toEqual([
      {
        id: "invalid-spec:a.yaml:1:5",
        category: "invalid-spec",
        severity: "warning",
        message: "w",
        behavior: "B",
        transition: "t",
        specAt: at(1, 5),
        hint: "h",
      },
      {
        id: "invalid-spec:a.yaml:3:1",
        category: "invalid-spec",
        severity: "error",
        message: "a",
        behavior: "B",
        specAt: at(3, 1),
      },
      {
        id: "invalid-spec:a.yaml:3:1#2",
        category: "invalid-spec",
        severity: "error",
        message: "z",
        behavior: "B",
        specAt: at(3, 1),
      },
    ]);
  });

  it("warnings alone are not errors", () => {
    const out = new FindingCollector("a.yaml");
    out.warning(at(1, 1), "w");
    expect(out.hasErrors()).toBe(false);
  });
});

describe("suggest", () => {
  it("finds close matches only", () => {
    expect(suggest("refundd", ["paid", "refunded"])).toBe("refunded");
    expect(suggest("trasitions", ["behavior", "transitions"])).toBe("transitions");
    expect(suggest("to", ["by", "from"])).toBeUndefined();
    expect(suggest("color", ["from", "to", "by"])).toBeUndefined();
  });
});

describe("list", () => {
  it("truncates long lists", () => {
    expect(list([])).toBe("none");
    expect(list(["a", "b", "c"], 2)).toBe("a, b, …");
  });
});
