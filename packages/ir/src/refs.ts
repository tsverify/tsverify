import type { GuardBinding, GuardRef, SymbolRef } from "./model";

const SYMBOL_REF = /^([^#\s]+)#([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/;
const GUARD_REF = /^([A-Za-z_][\w-]*)(?:\(([^()]*)\))?$/;
const GUARD_BINDING = /^([^#\s]+)#([A-Za-z_$][\w$]*)(?:\(([^()]*)\))?$/;

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

/** `src/auth/guards.ts#requireRole("admin")` → `{ file, symbol: "requireRole", args: ["admin"] }`. */
export function parseGuardBinding(text: string): Omit<GuardBinding, "at"> | undefined {
  const raw = text.trim();
  const m = GUARD_BINDING.exec(raw);
  if (!m) return undefined;
  return { file: m[1] as string, symbol: m[2] as string, args: splitArgs(m[3]), raw };
}
