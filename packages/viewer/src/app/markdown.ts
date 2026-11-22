/**
 * Reads the Markdown subset `@tsv/render`'s `summarize` writes, so the app can show it as
 * elements without `innerHTML`: paragraphs, `- ` bullet lists, `**strong**`, `` `code` `` and
 * backslash escapes. Anything else stays literal text.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string };

export type Block = { type: "p"; inlines: Inline[] } | { type: "ul"; items: Inline[][] };

export function parseMarkdown(source: string): Block[] {
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: Inline[][] | undefined;
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ type: "p", inlines: parseInline(paragraph.join(" ")) });
    paragraph = [];
    if (list) blocks.push({ type: "ul", items: list });
    list = undefined;
  };
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") {
      flush();
    } else if (line.startsWith("- ")) {
      if (paragraph.length > 0) flush();
      list ??= [];
      list.push(parseInline(line.slice(2)));
    } else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const push = (inline: Inline) => {
    if (buffer) out.push({ type: "text", text: buffer });
    buffer = "";
    out.push(inline);
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "\\" && i + 1 < text.length) {
      buffer += text[i + 1];
      i += 2;
    } else if (text.startsWith("**", i)) {
      const end = findClosing(text, "**", i + 2);
      if (end < 0) {
        buffer += "**";
        i += 2;
        continue;
      }
      push({ type: "strong", text: unescapeMarkdown(text.slice(i + 2, end)) });
      i = end + 2;
    } else if (c === "`") {
      const fence = text.startsWith("``", i) ? "``" : "`";
      const end = text.indexOf(fence, i + fence.length);
      if (end < 0) {
        buffer += fence;
        i += fence.length;
        continue;
      }
      let code = text.slice(i + fence.length, end);
      if (code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "")
        code = code.slice(1, -1);
      push({ type: "code", text: code });
      i = end + fence.length;
    } else {
      buffer += c;
      i += 1;
    }
  }
  if (buffer) out.push({ type: "text", text: buffer });
  return out;
}

/** Index of the next unescaped `marker` at or after `from`, or -1. */
function findClosing(text: string, marker: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text.startsWith(marker, i)) return i;
  }
  return -1;
}

function unescapeMarkdown(text: string): string {
  return text.replace(/\\(.)/g, "$1");
}
