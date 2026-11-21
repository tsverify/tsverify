/**
 * Mermaid-safe identifiers and text, shared by the state diagram (`mermaid.ts`) and the
 * counterexample sequence diagram (`trace.ts`).
 */

/**
 * Characters that break Mermaid labels, mapped to Mermaid entity codes. Mermaid swaps `#<n>;`
 * codes out before parsing and decodes them in the rendered SVG, for every diagram type. That
 * makes the escape lossless: the diagram shows the original character.
 *
 * - `:` separates an edge from its label, and starts a label in notes and messages
 * - `;` ends a statement
 * - `#` starts an entity code
 * - `%` starts a `%%` comment
 * - `"` ends a quoted state label
 * - `<` `>` are treated as HTML
 * - `{` `}` open and close composite-state and directive blocks
 */
const ENTITY_CODES: Record<string, string> = {
  '"': "#34;",
  "#": "#35;",
  "%": "#37;",
  ":": "#58;",
  ";": "#59;",
  "<": "#60;",
  ">": "#62;",
  "{": "#123;",
  "}": "#125;",
};

const UNSAFE = /["#%:;<>{}]/g;

/** Escapes text for use in a Mermaid label, note, message or quoted state name. Newlines become spaces. */
export function escapeMermaidText(text: string): string {
  return text.replace(/\r?\n/g, " ").replace(UNSAFE, (c) => ENTITY_CODES[c] ?? c);
}

const PLAIN_ID = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Keywords of `stateDiagram-v2` and `sequenceDiagram` that the parsers reject (or misread) as a
 * bare id. Compared case-insensitively.
 */
const RESERVED = new Set([
  "activate",
  "actor",
  "alt",
  "and",
  "as",
  "autonumber",
  "box",
  "break",
  "class",
  "classdef",
  "click",
  "create",
  "critical",
  "deactivate",
  "default",
  "destroy",
  "direction",
  "else",
  "end",
  "hide",
  "left",
  "link",
  "links",
  "linkstyle",
  "loop",
  "note",
  "of",
  "opt",
  "over",
  "par",
  "participant",
  "rect",
  "right",
  "state",
  "statediagram",
  "style",
  "title",
]);

/** true when `name` can be written as a Mermaid id as-is. */
export function isPlainMermaidId(name: string): boolean {
  return PLAIN_ID.test(name) && !RESERVED.has(name.toLowerCase());
}

/**
 * Assigns a unique, valid Mermaid id to every name. Plain names keep their own spelling. Others
 * are sanitized (`on-hold` → `on_hold`, `end` → `s_end`) and suffixed (`_2`, `_3`, …) on collision.
 * Plain names are assigned first, so they always win their own spelling. `taken` reserves ids
 * the caller uses itself.
 */
export function assignMermaidIds(
  names: readonly string[],
  taken: readonly string[] = [],
): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set(taken.map((t) => t.toLowerCase()));
  const unique = [...new Set(names)];
  for (const name of unique) {
    if (isPlainMermaidId(name) && !used.has(name.toLowerCase())) {
      ids.set(name, name);
      used.add(name.toLowerCase());
    }
  }
  for (const name of unique) {
    if (ids.has(name)) continue;
    let base = name.replace(/[^A-Za-z0-9_]/g, "_");
    if (!isPlainMermaidId(base)) base = `s_${base}`;
    let id = base;
    for (let n = 2; used.has(id.toLowerCase()); n++) id = `${base}_${n}`;
    ids.set(name, id);
    used.add(id.toLowerCase());
  }
  return ids;
}
