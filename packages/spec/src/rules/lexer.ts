/**
 * Tokens of the rule-expression language (docs/behavior-format.md, `rules[]`).
 *
 * Words are lexed as `word` tokens and keywords (`status`, `and`, …) are recognised by the parser
 * from context, so a state or effect may share a name with a keyword. A word may contain `-` after
 * its first character and may be dotted (`stripe.refund`).
 */
export type TokenKind = "word" | "int" | "op" | "punct" | "eof";

export interface Token {
  kind: TokenKind;
  text: string;
  /** 0-based offset of the first character in the expression text. */
  offset: number;
  /** 0-based offset just past the last character. */
  end: number;
}

export interface RuleSyntaxError {
  message: string;
  offset: number;
}

export type LexResult = { tokens: Token[] } | { error: RuleSyntaxError };

const WORD = /[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*/y;
const INT = /\d+/y;
const OPS = ["==", "!=", "<=", ">=", "<", ">"] as const;
const PUNCT = new Set(["(", ")", "[", "]", ","]);

const MISSPELLED_OPS: Record<string, string> = {
  "=": 'did you mean "=="?',
  "!": 'use "not" or "!="',
  "&": 'use "and"',
  "|": 'use "or"',
};

export function lex(text: string): LexResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    WORD.lastIndex = i;
    const word = WORD.exec(text);
    if (word) {
      const end = i + word[0].length;
      if (text[end] === ".") {
        return { error: { message: `expected a name after "." in "${word[0]}."`, offset: end } };
      }
      tokens.push({ kind: "word", text: word[0], offset: i, end });
      i = end;
      continue;
    }
    INT.lastIndex = i;
    const int = INT.exec(text);
    if (int) {
      const end = i + int[0].length;
      if (end < text.length && /[\w.]/.test(text[end] as string)) {
        return { error: { message: `invalid number "${int[0]}${text[end]}…"`, offset: i } };
      }
      tokens.push({ kind: "int", text: int[0], offset: i, end });
      i = end;
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    if (op) {
      tokens.push({ kind: "op", text: op, offset: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: "punct", text: ch, offset: i, end: i + 1 });
      i++;
      continue;
    }
    const hint = MISSPELLED_OPS[ch];
    return {
      error: { message: `unexpected character "${ch}"${hint ? ` (${hint})` : ""}`, offset: i },
    };
  }
  tokens.push({ kind: "eof", text: "", offset: text.length, end: text.length });
  return { tokens };
}
