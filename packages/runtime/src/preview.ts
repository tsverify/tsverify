/** Short one-line rendering of a value for error messages. */
export function preview(v: unknown, max = 80): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
