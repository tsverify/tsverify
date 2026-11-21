/**
 * Locale-independent string ordering (UTF-16 code units). `localeCompare` depends on the host's
 * ICU data, which would make golden files differ between machines.
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
