import type { SourceLocation } from "@tsv/ir";
import { type Document, isMap, isNode, isScalar, isSeq, type LineCounter, type Node } from "yaml";

/** A path into the YAML document, e.g. `["transitions", "refund", "effects", 0]`. */
export type Path = readonly (string | number)[];

interface Resolved {
  /** The node at the path, or the deepest node reached. */
  node?: Node;
  /** Key of the last map entry walked through. */
  key?: Node;
  /** true if the whole path was found. */
  exact: boolean;
  /** true if the walk stopped because it hit a scalar (e.g. indexing `from: draft` as a list). */
  atScalar: boolean;
}

/**
 * Maps YAML paths to `SourceLocation`s (1-based lines and columns; `endLine`/`endColumn` point just
 * past the last character). When the path does not exist, it falls back to the most specific node
 * that does: a missing key resolves to the key of its parent entry, and indexing into a scalar
 * (shorthand `from: draft` addressed as `from[0]`) resolves to that scalar.
 */
export class Locator {
  constructor(
    private readonly doc: Document,
    private readonly lineCounter: LineCounter,
    private readonly text: string,
    readonly file: string,
  ) {}

  /** Location of a character span, given as offsets into the YAML text. */
  span(start: number, end = start): SourceLocation {
    const s = this.lineCounter.linePos(start);
    const e = this.lineCounter.linePos(Math.max(start, end));
    return { file: this.file, line: s.line, column: s.col, endLine: e.line, endColumn: e.col };
  }

  /** The value at `path`. */
  value(path: Path): SourceLocation {
    const r = this.resolve(path);
    if (r.exact || r.atScalar) {
      if (r.node) return this.nodeSpan(r.node);
      if (r.key) return this.nodeSpan(r.key);
    }
    if (r.key) return this.nodeSpan(r.key);
    if (r.node?.range) return this.span(r.node.range[0]);
    return this.span(0);
  }

  /** The key of the map entry at `path` (falls back to `value`). */
  key(path: Path): SourceLocation {
    const r = this.resolve(path);
    if (r.exact && r.key && path.length > 0 && typeof path[path.length - 1] === "string") {
      return this.nodeSpan(r.key);
    }
    return this.value(path);
  }

  /** A whole map entry at `path`: from the start of its key to the end of its value. */
  entry(path: Path): SourceLocation {
    const r = this.resolve(path);
    if (r.exact && r.key?.range && typeof path[path.length - 1] === "string") {
      const end = r.node?.range ? r.node.range[1] : r.key.range[1];
      return this.span(r.key.range[0], this.trimEnd(r.key.range[0], end));
    }
    return this.value(path);
  }

  /**
   * A span `[start, end)` inside the string scalar at `path`, given as offsets into the scalar's
   * *value*. Exact for single-line plain and quoted scalars without escapes; otherwise the whole
   * scalar is returned.
   */
  inScalar(path: Path, start: number, end = start): SourceLocation {
    const r = this.resolve(path);
    const node = r.node;
    if (!r.exact || !isScalar(node) || !node.range || typeof node.value !== "string") {
      return this.value(path);
    }
    const [from, to] = node.range;
    const source = this.text.slice(from, to);
    let base: number | undefined;
    if (node.type === "PLAIN" && source === node.value) base = from;
    if ((node.type === "QUOTE_DOUBLE" || node.type === "QUOTE_SINGLE") && !source.includes("\n")) {
      if (source.slice(1, -1) === node.value) base = from + 1;
    }
    if (base === undefined) return this.value(path);
    return this.span(base + start, base + end);
  }

  private nodeSpan(node: Node): SourceLocation {
    if (!node.range) return this.span(0);
    const [start, end] = node.range;
    return this.span(start, this.trimEnd(start, end));
  }

  /** Block collections' ranges include the trailing newline; locations should not. */
  private trimEnd(start: number, end: number): number {
    let e = end;
    while (e > start && /\s/.test(this.text[e - 1] as string)) e--;
    return e;
  }

  private resolve(path: Path): Resolved {
    let node: unknown = this.doc.contents;
    let key: Node | undefined;
    for (const seg of path) {
      if (isMap(node)) {
        const pair = node.items.find((p) => keyText(p.key) === String(seg));
        if (!pair) return { node, key, exact: false, atScalar: false };
        key = isNode(pair.key) ? pair.key : undefined;
        node = pair.value;
      } else if (isSeq(node) && typeof seg === "number") {
        const item = node.items[seg];
        if (item === undefined) return { node, key, exact: false, atScalar: false };
        key = undefined;
        node = item;
      } else {
        return { node: isNode(node) ? node : undefined, key, exact: false, atScalar: true };
      }
    }
    return { node: isNode(node) ? node : undefined, key, exact: true, atScalar: false };
  }
}

function keyText(key: unknown): string | undefined {
  if (isScalar(key)) return String(key.value);
  return typeof key === "string" ? key : undefined;
}
