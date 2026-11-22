import type { Finding, SourceLocation } from "@tsverify/ir";

/**
 * An `info` finding (category `not-generated`) that explains why `tsv test` generated no test for
 * something. Ids are `not-generated:<behavior>:testgen[:<subject>]`.
 */
export function skipFinding(
  behavior: string,
  subject: string | undefined,
  message: string,
  extra: { transition?: string; specAt?: SourceLocation; hint?: string } = {},
): Finding {
  const finding: Finding = {
    id: `not-generated:${behavior}:testgen${subject === undefined ? "" : `:${subject}`}`,
    category: "not-generated",
    severity: "info",
    message,
    behavior,
  };
  if (extra.transition !== undefined) finding.transition = extra.transition;
  if (extra.specAt !== undefined) finding.specAt = extra.specAt;
  if (extra.hint !== undefined) finding.hint = extra.hint;
  return finding;
}
