import type { GuardBinding, GuardRef, SymbolRef } from "./model";

/** `path#symbol`, `path#Class.method`, `path#Class.#privateMethod`. */
const SYMBOL_REF = /^([^#\s]+)#([A-Za-z_$][\w$]*(?:\.#?[A-Za-z_$][\w$]*)*)$/;
const GUARD_REF = /^([A-Za-z_][\w-]*)(?:\(([^()]*)\))?$/;
const GUARD_BINDING = /^([^#\s]+)#([A-Za-z_$][\w$]*)(?:\((.*)\))?$/s;

/** `src/orders/refund.ts#refundOrder` → `{ file, symbol }`. Returns undefined if malformed. */
export function parseSymbolRef(text: string): SymbolRef | undefined {
  const m = SYMBOL_REF.exec(text.trim());
  if (!m) return undefined;
  return { file: m[1] as string, symbol: m[2] as string };
}

export function formatSymbolRef(ref: SymbolRef): string {
  return `${ref.file}#${ref.symbol}`;
}

function splitArgs(argText: string | undefined): string[] {
  if (argText === undefined || argText.trim() === "") return [];
  return argText.split(",").map((a) => a.trim().replace(/^(["'])(.*)\1$/, "$2"));
}

/** `owner` → `{ name: "owner", args: [] }`; `role(admin)` → `{ name: "role", args: ["admin"] }`. */
export function parseGuardRef(text: string): GuardRef | undefined {
  const m = GUARD_REF.exec(text.trim());
  if (!m) return undefined;
  const name = m[1] as string;
  const args = splitArgs(m[2]);
  return { name, args, raw: formatGuardRef({ name, args }) };
}

export function formatGuardRef(ref: Pick<GuardRef, "name" | "args">): string {
  return ref.args.length === 0 ? ref.name : `${ref.name}(${ref.args.join(", ")})`;
}

/**
 * `src/auth/guards.ts#requireRole("admin")` → `{ file, symbol: "requireRole", args: ["admin"] }`.
 * Undefined when malformed, including arguments `parseGuardArgs` can't read.
 */
export function parseGuardBinding(text: string): Omit<GuardBinding, "at"> | undefined {
  const raw = text.trim();
  const m = GUARD_BINDING.exec(raw);
  if (!m) return undefined;
  const args = m[3] === undefined ? [] : parseGuardArgs(m[3]);
  if (!args) return undefined;
  return { file: m[1] as string, symbol: m[2] as string, args, raw };
}

/**
 * Canonical text of a list argument, as guard bindings and the extractor both write it:
 * `["owner", "admin"]` (each item a JSON string), whatever quotes and spacing the source used.
 */
export function formatGuardArgList(items: readonly string[]): string {
  return `[${items.map((i) => JSON.stringify(i)).join(", ")}]`;
}

/** Characters that end a bare (unquoted) guard argument. */
const BARE_STOP = new Set([",", "[", "]", "(", ")", "{", "}", '"', "'", "`"]);

/**
 * A guard binding's argument list, e.g. `"admin", 2, ["owner", 'admin']`. Each argument is a
 * string in double or single quotes, a bare word or number (`admin`, `2`, `true`), or a list of
 * those in `[ ]`. Each comes back as canonical text: a scalar as its value (`admin`, `2`), a list
 * as `formatGuardArgList` of its items, so the quote style and spacing don't matter. Undefined
 * for anything else (an object, a call, a nested list, an unclosed quote): such a binding could
 * never match a call, so the spec rejects it.
 */
export function parseGuardArgs(text: string): string[] | undefined {
  let i = 0;
  const skip = () => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };
  const scalar = (): string | undefined => {
    skip();
    const quote = text[i];
    if (quote === '"' || quote === "'") {
      let out = "";
      for (i++; i < text.length && text[i] !== quote; i++) {
        if (text[i] === "\\" && i + 1 < text.length) i++;
        out += text[i];
      }
      if (text[i] !== quote) return undefined;
      i++;
      return out;
    }
    const start = i;
    while (i < text.length && !BARE_STOP.has(text[i] as string)) i++;
    const bare = text.slice(start, i).trim();
    return bare === "" ? undefined : bare;
  };
  const value = (): string | undefined => {
    skip();
    if (text[i] !== "[") return scalar();
    i++;
    const items: string[] = [];
    skip();
    if (text[i] === "]") {
      i++;
      return formatGuardArgList(items);
    }
    for (;;) {
      const item = scalar();
      if (item === undefined) return undefined;
      items.push(item);
      skip();
      if (text[i] === "]") {
        i++;
        return formatGuardArgList(items);
      }
      if (text[i] !== ",") return undefined;
      i++;
    }
  };
  const args: string[] = [];
  skip();
  if (i === text.length) return args;
  for (;;) {
    const v = value();
    if (v === undefined) return undefined;
    args.push(v);
    skip();
    if (i === text.length) return args;
    if (text[i] !== ",") return undefined;
    i++;
  }
}
