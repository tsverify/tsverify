import type { CAC } from "cac";

/**
 * Works around a cac 7 bug: boolean options are registered with mri under their camelCased name
 * (`specOnly`), but mri sees the raw `--spec-only`, so it doesn't know the flag is boolean and
 * takes the next argument as its value (`tsverify check --spec-only specs/` would lose `specs/`).
 * Rewriting the kebab-case spelling of known boolean flags to camelCase before parsing avoids it.
 */
export function camelCaseBooleanFlags(argv: readonly string[], cli: CAC): string[] {
  const booleans = new Set(
    [cli.globalCommand, ...cli.commands]
      .flatMap((c) => c.options)
      .filter((o) => o.isBoolean)
      .flatMap((o) => o.names),
  );
  const end = argv.indexOf("--");
  return argv.map((arg, i) => {
    if ((end !== -1 && i > end) || !arg.startsWith("--") || !arg.includes("-", 2)) return arg;
    const name = arg.slice(2).replace(/([a-z])-([a-z])/g, (_, a: string, b: string) => {
      return a + b.toUpperCase();
    });
    return booleans.has(name) ? `--${name}` : arg;
  });
}
