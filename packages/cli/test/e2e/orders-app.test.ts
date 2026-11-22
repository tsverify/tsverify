/**
 * End-to-end: `tsv check` over the demo app (examples/orders-app), clean and with every
 * seeded-bug variant, in-process through `main` with the materialized app as the cwd.
 */
import type { Finding } from "@tsv/ir";
import { describe, expect, it } from "vitest";
import {
  type ExpectedFinding,
  listVariants,
  materialize,
  readManifest,
} from "../../../../examples/orders-app/test/materialize";
import { type Io, main } from "../../src/main";
import type { JsonReport } from "../../src/output/json";

const CLEAN = "clean";
const VARIANTS = await listVariants();

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(argv: string[], cwd: string): Promise<Run> {
  const out = { stdout: "", stderr: "" };
  const io: Io = {
    stdout: (s) => {
      out.stdout += s;
    },
    stderr: (s) => {
      out.stderr += s;
    },
    cwd,
    isTTY: false,
    env: {},
  };
  const code = await main(argv, io);
  // Nothing machine-specific should leak, but keep the goldens portable if it ever does.
  const strip = (s: string) => s.replaceAll(cwd, "<root>");
  return { code, stdout: strip(out.stdout), stderr: strip(out.stderr) };
}

/** Matches only the fields `expected` gives (see examples/orders-app/variants/README.md). */
function matches(f: Finding, expected: ExpectedFinding): boolean {
  const { category, transition, property, subject, file } = expected;
  return (
    f.category === category &&
    (transition === undefined || f.transition === transition) &&
    (property === undefined || f.property === property) &&
    (subject === undefined || f.id.endsWith(`:${subject}`)) &&
    (file === undefined || f.codeAt?.file === file || f.specAt?.file === file)
  );
}

async function checkApp(variant: string): Promise<{ json: Run; pretty: Run }> {
  const app = await materialize(variant === CLEAN ? undefined : variant);
  try {
    const json = await run(["check", "src", "--format", "json"], app.root);
    const pretty = await run(["check", "src"], app.root);
    return { json, pretty };
  } finally {
    await app.dispose();
  }
}

describe("tsv check on examples/orders-app", { timeout: 60_000 }, () => {
  it("has seeded-bug variants to check", () => {
    expect(VARIANTS.length).toBeGreaterThan(0);
  });

  it("passes the clean app with no findings", async () => {
    const { json, pretty } = await checkApp(CLEAN);
    expect(json.stderr).toBe("");
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout) as JsonReport;
    expect(doc.findings).toEqual([]);
    expect(doc.specs).toEqual([
      expect.objectContaining({ file: "src/orders/order.behavior.yaml", project: "." }),
    ]);
    await expect(json.stdout).toMatchFileSnapshot(`__golden__/${CLEAN}.json`);
    expect(pretty.code).toBe(0);
    await expect(pretty.stdout).toMatchFileSnapshot(`__golden__/${CLEAN}.pretty.txt`);
  });

  it.each(VARIANTS)("fails %s with its expected findings", async (variant) => {
    const manifest = await readManifest(variant);
    const { json, pretty } = await checkApp(variant);
    expect(json.stderr).toBe("");
    expect(json.code).toBe(1);
    const doc = JSON.parse(json.stdout) as JsonReport;
    for (const expected of manifest.expected) {
      expect(
        doc.findings.some((f) => matches(f, expected)),
        `no finding matches ${JSON.stringify(expected)}`,
      ).toBe(true);
    }
    await expect(json.stdout).toMatchFileSnapshot(`__golden__/${variant}.json`);
    expect(pretty.code).toBe(1);
    await expect(pretty.stdout).toMatchFileSnapshot(`__golden__/${variant}.pretty.txt`);
  });
});
