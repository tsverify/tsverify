import { describe, expect, it } from "vitest";
import { assignMermaidIds, escapeMermaidText, isPlainMermaidId } from "./mermaid-text";

describe("escapeMermaidText", () => {
  it("replaces every label-breaking character with an entity code", () => {
    expect(escapeMermaidText('a:b;c#d"e<f>g{h}i%j')).toBe(
      "a#58;b#59;c#35;d#34;e#60;f#62;g#123;h#125;i#37;j",
    );
  });
  it("does not double-escape its own entity codes", () => {
    expect(escapeMermaidText("#1;")).toBe("#35;1#59;");
  });
  it("leaves ordinary and non-ASCII text alone", () => {
    expect(escapeMermaidText("refund · admin (role(admin)) · ⟳ ×1")).toBe(
      "refund · admin (role(admin)) · ⟳ ×1",
    );
  });
  it("flattens newlines", () => {
    expect(escapeMermaidText("a\nb\r\nc")).toBe("a b c");
  });
});

describe("isPlainMermaidId", () => {
  it.each(["draft", "pending_payment", "_x", "S1"])("accepts %s", (id) => {
    expect(isPlainMermaidId(id)).toBe(true);
  });
  it.each(["on-hold", "1st", "", "a b", "end", "State", "note"])("rejects %s", (id) => {
    expect(isPlainMermaidId(id)).toBe(false);
  });
});

describe("assignMermaidIds", () => {
  it("keeps plain names and sanitizes the rest", () => {
    const ids = assignMermaidIds(["draft", "on-hold", "end", "2fa", "refund#1"]);
    expect(Object.fromEntries(ids)).toEqual({
      draft: "draft",
      "on-hold": "on_hold",
      end: "s_end",
      "2fa": "s_2fa",
      "refund#1": "refund_1",
    });
  });
  it("lets a plain name keep its spelling even when listed after a colliding one", () => {
    const ids = assignMermaidIds(["on-hold", "on_hold", "on hold"]);
    expect(Object.fromEntries(ids)).toEqual({
      "on-hold": "on_hold_2",
      on_hold: "on_hold",
      "on hold": "on_hold_3",
    });
  });
  it("avoids ids the caller reserved", () => {
    expect(assignMermaidIds(["Entity"], ["Entity"]).get("Entity")).toBe("Entity_2");
  });
});
