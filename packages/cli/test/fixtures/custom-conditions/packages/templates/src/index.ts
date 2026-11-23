/** A workspace package: its `exports` point at `dist/` (never built here) unless resolved with `acme-source`. */
export function shippedTemplate(): string {
  return "shipped";
}
