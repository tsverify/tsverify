import type { BehaviorModel } from "@tsverify/ir";
import { diffModels } from "@tsverify/ir";
import { orderModel } from "@tsverify/ir/testing";
import {
  DIFF_COMMENT_MARKER,
  diffSummary,
  renderDiffMarkdown,
  renderDiffText,
  toMermaidDiff,
} from "@tsverify/render";
import { describe, expect, it } from "vitest";
import { escapingModel, orderDiffHead } from "./models";

const FILE = "src/orders/order.behavior.yaml";
const OPTIONS = { base: "origin/main" };

/** Edge lines of a flowchart (`a --> b`, with any arrow), without the leading indent. */
function edges(mermaid: string): string[] {
  return mermaid
    .split("\n")
    .filter((l) => / (-->|==>|-\.->)/.test(l))
    .map((l) => l.trim());
}

describe("toMermaidDiff", () => {
  it("marks added, removed and changed states and edges", async () => {
    const out = toMermaidDiff(orderModel(), orderDiffHead());
    expect(out.startsWith("flowchart LR\n")).toBe(true);
    const lines = edges(out);
    // Changed transition: same edge, `~` and a normal arrow.
    expect(lines).toContain(
      'paid -->|"~ refund · admin · stripe.refund ×1 · ⚠ non-atomic"| refunded',
    );
    // Added transition and an added source state of a changed one: `+` and a thick arrow.
    expect(lines).toContain('paid ==>|"+ hold · admin"| on_hold');
    expect(lines).toContain('on_hold ==>|"+ ship · admin"| shipped');
    // The edge `ship` keeps is marked changed, since the transition changed.
    expect(lines).toContain('paid -->|"~ ship · admin"| shipped');
    // Removed transition, drawn from the base: `−` and a dotted arrow.
    expect(lines).toContain('pending_payment -.->|"− expire · system · after 30m"| cancelled');
    // Unchanged transitions carry no marker.
    expect(lines).toContain('draft -->|"checkout · customer (owner)"| pending_payment');
    expect(out).toContain('  on_hold("+ on_hold")\n');
    expect(out).toContain('  shipped(["shipped"])\n');
    expect(out).toContain("  class on_hold added\n");
    await expect(out).toMatchFileSnapshot("__golden__/order-diff.mmd");
  });

  it("styles exactly the marked edges, by index", () => {
    const out = toMermaidDiff(orderModel(), orderDiffHead());
    const lines = edges(out);
    const styled = (color: string) =>
      out
        .split("\n")
        .find((l) => l.includes(`stroke:${color}`) && l.includes("linkStyle"))
        ?.split(" ")[3]
        ?.split(",")
        .map(Number) ?? [];
    const indexes = (marker: string) =>
      lines.flatMap((l, i) => (l.includes(`|"${marker} `) ? [i] : []));
    expect(styled("#16a34a")).toEqual(indexes("+"));
    expect(styled("#dc2626")).toEqual(indexes("−"));
    expect(styled("#d97706")).toEqual(indexes("~"));
  });

  it("draws an added behavior all added and a changed initial state as two start arrows", () => {
    const added = toMermaidDiff(undefined, orderModel());
    expect(
      edges(added)
        .filter((l) => !l.startsWith("start "))
        .every((l) => l.includes("==>")),
    ).toBe(true);
    const head: BehaviorModel = {
      ...orderModel(),
      entity: { ...orderModel().entity, initial: "pending_payment" },
    };
    const lines = edges(toMermaidDiff(orderModel(), head));
    expect(lines.slice(0, 2)).toEqual(['start ==>|"+"| pending_payment', 'start -.->|"−"| draft']);
  });

  it("renames flowchart keywords and escapes labels", async () => {
    const base = escapingModel();
    const head = { ...base, transitions: base.transitions.filter((t) => t.name !== "page") };
    const out = toMermaidDiff(base, head);
    // `end` is a flowchart keyword: it gets its own id.
    expect(out).toContain('  s_end(["end"])\n');
    expect(out).toContain(
      'open -->|"hold#58; see #35;42 · agent (team(a#59;b)) · notify#60;ops#62; ×n"| on_hold_2',
    );
    await expect(out).toMatchFileSnapshot("__golden__/escaping-diff.mmd");
  });

  it("is deterministic regardless of input order", () => {
    const head = orderDiffHead();
    const reversed = { ...head, transitions: [...head.transitions].reverse() };
    expect(toMermaidDiff(orderModel(), reversed)).toBe(toMermaidDiff(orderModel(), head));
  });
});

describe("diffSummary", () => {
  it("counts changes per section", () => {
    expect(diffSummary(diffModels(orderModel(), orderDiffHead()))).toBe(
      "~1 top-level field, +1 state, +2 transitions, −1 transition, ~2 transitions, −1 rule, ~1 binding",
    );
    expect(diffSummary(diffModels(orderModel(), orderModel()))).toBe("no changes");
  });
});

describe("renderDiffMarkdown", () => {
  it("renders a changed behavior as a PR comment", async () => {
    const out = renderDiffMarkdown(
      [
        { file: FILE, base: orderModel(), head: orderDiffHead() },
        { file: "src/other.behavior.yaml", base: orderModel(), head: orderModel() },
      ],
      OPTIONS,
    );
    expect(out.startsWith(`${DIFF_COMMENT_MARKER}\n`)).toBe(true);
    expect(out).toContain("### Order lifecycle · changed\n");
    expect(out).toContain("| ~ | `refund` | atomic: `yes` → `no` |\n");
    expect(out).toContain("| ~ | `enforced` | `no` → `yes` |\n");
    expect(out).toContain("Unchanged: `src/other.behavior.yaml`.\n");
    await expect(out).toMatchFileSnapshot("__golden__/order-diff.md");
  });

  it("renders added and removed behaviors", async () => {
    const out = renderDiffMarkdown(
      [
        { file: "b.behavior.yaml", head: escapingModel() },
        { file: "a.behavior.yaml", base: orderModel() },
      ],
      { base: "HEAD~1", head: "HEAD" },
    );
    expect(out.indexOf("Order lifecycle · removed")).toBeLessThan(
      out.indexOf("### Ticket: support \\#1 · added"),
    );
    await expect(out).toMatchFileSnapshot("__golden__/added-removed-diff.md");
  });

  it("says when nothing changed", () => {
    const out = renderDiffMarkdown(
      [{ file: FILE, base: orderModel(), head: orderModel() }],
      OPTIONS,
    );
    expect(out).toBe(
      `${DIFF_COMMENT_MARKER}\n## Behavior diff\n\n\`origin/main\` → working tree: no behavior changes (1 behavior file compared).\n`,
    );
  });
});

describe("renderDiffText", () => {
  it("prints a compact terminal view", async () => {
    const out = renderDiffText(
      [
        { file: FILE, base: orderModel(), head: orderDiffHead() },
        { file: "src/other.behavior.yaml", base: orderModel(), head: orderModel() },
      ],
      OPTIONS,
    );
    expect(out).toContain("  ~ transition refund  atomic: yes → no\n");
    expect(out).toContain("  + transition hold\n");
    expect(out.endsWith("\n1 of 2 behavior files changed (origin/main → working tree)\n")).toBe(
      true,
    );
    await expect(out).toMatchFileSnapshot("__golden__/order-diff.txt");
  });
});
