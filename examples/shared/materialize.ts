/**
 * Builds runnable copies of an example app, optionally with a seeded-bug variant applied. Shared
 * by every example (`examples/orders-app`, `examples/orders-prisma`): each app's
 * `test/materialize.ts` binds it to its own directory with `exampleApp(new URL("..", import.meta.url))`.
 *
 * A variant (`variants/<id>/`) is an overlay: it holds only the files it replaces, at the same
 * relative paths as in the app, plus a `variant.json` manifest. Used by the apps' own tests and
 * by the `tsv` end-to-end suites.
 */
import { copyFile, cp, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, FindingCategory } from "@tsverify/ir";

export const MANIFEST = "variant.json";

/** Top-level entries of an app directory that are not part of the app under analysis. */
const NOT_APP: ReadonlySet<string> = new Set(["node_modules", "test", "variants", ".tsv"]);

/** Every finding category, checked against `FindingCategory` at compile time. */
const CATEGORIES: Record<FindingCategory, true> = {
  "invalid-spec": true,
  "broken-link": true,
  "spec-property": true,
  "implementation-property": true,
  "undeclared-transition": true,
  "missing-transition": true,
  "from-state-mismatch": true,
  "from-state-unconstrained": true,
  "guard-not-dominating": true,
  "undeclared-effect": true,
  "missing-effect": true,
  "non-atomic": true,
  "generated-test-failed": true,
  "replay-confirmed": true,
  "replay-disagrees": true,
  unanalyzable: true,
  "not-generated": true,
};

/**
 * A finding the variant must produce. Only the fields given are matched:
 * `category`, `transition` and `property` against the same `Finding` fields, `subject` against the
 * `:<subject>` suffix of `Finding.id`, and `file` against `Finding.codeAt.file`.
 */
export interface ExpectedFinding {
  category: FindingCategory;
  transition?: string;
  property?: string;
  subject?: string;
  file?: string;
}

export interface VariantManifest {
  /** Equal to the variant's directory name. */
  id: string;
  /** One line: what is wrong. */
  bug: string;
  /** Lower bound: knock-on findings of the same bug may also appear. */
  expected: ExpectedFinding[];
}

export interface MaterializedApp {
  /** Absolute path of the copy; contains `tsconfig.json`, `package.json` and `src/`. */
  root: string;
  /** Overlay files applied, relative to `root`. Empty for the clean app. */
  overlay: string[];
  dispose(): Promise<void>;
}

const EXPECTED_KEYS: ReadonlySet<string> = new Set([
  "category",
  "transition",
  "property",
  "subject",
  "file",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseExpected(value: unknown, where: string): ExpectedFinding {
  if (!isRecord(value)) throw new Error(`${where}: expected an object`);
  for (const key of Object.keys(value)) {
    if (!EXPECTED_KEYS.has(key)) throw new Error(`${where}: unknown key "${key}"`);
  }
  const { category, ...rest } = value;
  if (typeof category !== "string" || !Object.hasOwn(CATEGORIES, category)) {
    throw new Error(`${where}: unknown category ${JSON.stringify(category)}`);
  }
  const finding: ExpectedFinding = { category: category as FindingCategory };
  for (const [key, field] of Object.entries(rest)) {
    if (typeof field !== "string" || field === "") throw new Error(`${where}.${key}: not a string`);
    if (key === "transition") finding.transition = field;
    else if (key === "property") finding.property = field;
    else if (key === "subject") finding.subject = field;
    else finding.file = field;
  }
  return finding;
}

/** Validates a parsed `variant.json`. Throws with a readable message on the first problem. */
export function parseManifest(value: unknown, source = MANIFEST): VariantManifest {
  if (!isRecord(value)) throw new Error(`${source}: expected an object`);
  const { id, bug, expected, ...extra } = value;
  const [unknownKey] = Object.keys(extra);
  if (unknownKey !== undefined) throw new Error(`${source}: unknown key "${unknownKey}"`);
  if (typeof id !== "string" || id === "") throw new Error(`${source}: id must be a string`);
  if (typeof bug !== "string" || bug === "" || bug.includes("\n")) {
    throw new Error(`${source}: bug must be one line`);
  }
  if (!Array.isArray(expected) || expected.length === 0) {
    throw new Error(`${source}: expected must be a non-empty list`);
  }
  return {
    id,
    bug,
    expected: expected.map((e, i) => parseExpected(e, `${source}: expected[${i}]`)),
  };
}

/** Whether a finding satisfies an expectation (only the fields `expected` gives are matched). */
export function matchesExpected(f: Finding, expected: ExpectedFinding): boolean {
  const { category, transition, property, subject, file } = expected;
  return (
    f.category === category &&
    (transition === undefined || f.transition === transition) &&
    (property === undefined || f.property === property) &&
    (subject === undefined || f.id.endsWith(`:${subject}`)) &&
    (file === undefined || f.codeAt?.file === file || f.specAt?.file === file)
  );
}

async function walk(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await walk(join(dir, entry.name), path)));
    else files.push(path);
  }
  return files;
}

/** One example app: its directory, its variants and how to materialize them. */
export interface ExampleApp {
  /** Absolute path of the app directory (with `src/`, `variants/`, `test/`). */
  APP_ROOT: string;
  VARIANTS_ROOT: string;
  /** Variant ids (directory names under `variants/`), sorted. */
  listVariants(): Promise<string[]>;
  readManifest(id: string): Promise<VariantManifest>;
  /** The files a variant replaces, as `/`-separated paths relative to the app root, sorted. */
  overlayFiles(id: string): Promise<string[]>;
  /**
   * Copies the app into a fresh temporary directory and applies the variant's overlay, if any.
   * Call `dispose()` when done.
   */
  materialize(variant?: string): Promise<MaterializedApp>;
}

/** Binds the helpers to the app at `appRoot` (a directory URL or absolute path). */
export function exampleApp(appRoot: URL | string): ExampleApp {
  const APP_ROOT = typeof appRoot === "string" ? appRoot : fileURLToPath(appRoot);
  const VARIANTS_ROOT = join(APP_ROOT, "variants");
  const name = basename(APP_ROOT);

  const overlayFiles = async (id: string): Promise<string[]> => {
    const files = await walk(join(VARIANTS_ROOT, id));
    return files.filter((f) => f !== MANIFEST).sort();
  };

  return {
    APP_ROOT,
    VARIANTS_ROOT,
    async listVariants() {
      const entries = await readdir(VARIANTS_ROOT, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    },
    async readManifest(id) {
      const source = join(VARIANTS_ROOT, id, MANIFEST);
      const manifest = parseManifest(JSON.parse(await readFile(source, "utf8")), source);
      if (manifest.id !== id) throw new Error(`${source}: id "${manifest.id}" ≠ directory "${id}"`);
      return manifest;
    },
    overlayFiles,
    async materialize(variant) {
      const root = await mkdtemp(join(tmpdir(), `${name}-${variant ?? "clean"}-`));
      try {
        for (const entry of await readdir(APP_ROOT)) {
          if (NOT_APP.has(entry)) continue;
          await cp(join(APP_ROOT, entry), join(root, entry), { recursive: true });
        }
        const overlay = variant === undefined ? [] : await overlayFiles(variant);
        for (const file of overlay) {
          const target = join(root, file);
          await mkdir(dirname(target), { recursive: true });
          await copyFile(join(VARIANTS_ROOT, variant ?? "", file), target);
        }
        return { root, overlay, dispose: () => rm(root, { recursive: true, force: true }) };
      } catch (error) {
        await rm(root, { recursive: true, force: true });
        throw error;
      }
    },
  };
}
