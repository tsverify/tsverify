/**
 * The YAML in the user-facing docs stays valid. `docs/` has no package, so the test lives here.
 *
 * - Every fenced `yaml` block parses as YAML (fragments are allowed).
 * - Every block whose first line is `# tsv:example` is a complete spec: `parseSpec` reports
 *   no findings at all.
 * - Every fenced `json` block parses as JSON.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { parseSpec } from "../src/index";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const AGENTS = "docs/agents";
const DOCS = [
  "docs/authoring-guide.md",
  "README.md",
  ...(existsSync(`${ROOT}${AGENTS}`) ? readdirSync(`${ROOT}${AGENTS}`) : [])
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `${AGENTS}/${f}`),
];
const EXAMPLE_MARKER = "# tsv:example";

interface Block {
  lang: string;
  text: string;
  /** 1-based line of the first line inside the fence. */
  line: number;
}

function fencedBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\w+)\s*$/.exec(lines[i] as string);
    if (!open) continue;
    const start = i + 1;
    let end = start;
    while (end < lines.length && lines[end] !== "```") end++;
    blocks.push({
      lang: open[1] as string,
      text: lines.slice(start, end).join("\n"),
      line: start + 1,
    });
    i = end;
  }
  return blocks;
}

const blocks = DOCS.map((doc) => {
  const text = readFileSync(`${ROOT}${doc}`, "utf8");
  return {
    doc,
    fences: text.split("\n").filter((l) => l.startsWith("```")).length,
    blocks: fencedBlocks(text),
  };
});

describe.each(blocks)("$doc", ({ doc, fences, blocks }) => {
  it("closes every code fence", () => {
    expect(fences % 2).toBe(0);
  });

  const yamlBlocks = blocks.filter((b) => b.lang === "yaml");
  const examples = yamlBlocks.filter((b) => b.text.startsWith(`${EXAMPLE_MARKER}\n`));

  it.each(yamlBlocks.map((b) => [`${doc}:${b.line}`, b] as const))("%s parses as YAML", (_, b) => {
    const parsed = parseDocument(b.text);
    expect(parsed.errors.map((e) => e.message)).toEqual([]);
  });

  it.each(examples.map((b) => [`${doc}:${b.line}`, b] as const))(
    "%s is a valid spec with no findings",
    (where, b) => {
      const { model, findings } = parseSpec(b.text, where);
      expect(findings).toEqual([]);
      expect(model).toBeDefined();
    },
  );

  it.each(blocks.filter((b) => b.lang === "json").map((b) => [`${doc}:${b.line}`, b] as const))(
    "%s parses as JSON",
    (_, b) => {
      expect(() => JSON.parse(b.text)).not.toThrow();
    },
  );
});

it("the authoring guide has complete examples, including a modeline", () => {
  const guide = blocks.find((b) => b.doc === "docs/authoring-guide.md")?.blocks ?? [];
  const examples = guide.filter((b) => b.lang === "yaml" && b.text.startsWith(EXAMPLE_MARKER));
  expect(examples.length).toBeGreaterThanOrEqual(3);
  expect(examples.some((b) => b.text.includes("# yaml-language-server: $schema="))).toBe(true);
});
