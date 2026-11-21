/** Deep-copies a value, dropping every `at` (source location) key. For location-insensitive comparisons. */
export function stripLocations<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (key, v) => (key === "at" ? undefined : v))) as T;
}
