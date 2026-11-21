// Bonus backend: the same probe-first technique against the TypeScript 7 native checker
// (tsgo), through the unstable sync API that ships in `typescript@7.0.2` (the repo root's
// devDependency). Probed file contents are served through the API's virtual-filesystem
// callbacks, so nothing is written to disk. Used by run.ts and narrowing.test.ts.

import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { API, TypeFlags } from "typescript/unstable/sync";
import {
  FIXTURE_TSCONFIG,
  type FromSet,
  findWriteSites,
  injectProbes,
  loadProject,
  probeOf,
  ts,
} from "./narrowing.ts";

const SRC = join(dirname(FIXTURE_TSCONFIG), "src");
const GEN = join(SRC, "gen");

interface Ts7Type {
  flags: number;
  value?: unknown;
  getTypes?: () => readonly Ts7Type[];
}

function literals7(t: Ts7Type): FromSet {
  if (t.flags & (TypeFlags.Any | TypeFlags.Unknown)) return "*";
  const parts = t.flags & TypeFlags.Union && t.getTypes ? t.getTypes() : [t];
  const out = new Set<string>();
  for (const p of parts) {
    if (p.flags & (TypeFlags.StringLiteral | TypeFlags.NumberLiteral)) out.add(String(p.value));
    else return "*";
  }
  return [...out].sort();
}

interface Probe {
  file: string;
  caseId: string;
  pos: number;
}

/** Probed texts (and probe positions) for the fixture plus `copies` synthetic copies. */
function buildOverlays(copies: number): { overlays: Map<string, string>; probes: Probe[] } {
  const overlays = new Map<string, string>();
  const probes: Probe[] = [];
  const add = (file: string, original: string) => {
    const parsed = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
    const sites = findWriteSites(parsed);
    if (sites.length === 0) return;
    const text = injectProbes(original, sites);
    overlays.set(file, text);
    const probed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const s of findWriteSites(probed)) {
      const probe = probeOf(s);
      if (!probe) throw new Error(`no probe for ${s.caseId}`);
      // The name identifier of `ref.status`: its type is the narrowed property-access type.
      probes.push({ file, caseId: s.caseId, pos: probe.name.getStart(probed) });
    }
  };
  for (const sf of loadProject().getSourceFiles()) {
    add(sf.getFilePath(), sf.getFullText());
    const text = sf.getFullText().replaceAll('"./order.js"', '"../order.js"');
    for (let i = 0; i < copies; i++)
      add(join(GEN, `${sf.getBaseName().slice(0, -3)}${i}.ts`), text);
  }
  return { overlays, probes };
}

export interface Ts7Result {
  /** caseId -> from-set, for the original fixture files only. */
  answers: Map<string, FromSet>;
  /** Spawn tsgo + load the project (lazy: no checking yet). */
  tOpen: number;
  /** All probe queries, one batched getTypeAtPosition call per file. */
  tQuery: number;
  probes: number;
  files: number;
  overlayReads: number;
  overlayCount: number;
}

export function runTs7(copies = 0): Ts7Result {
  const { overlays, probes } = buildOverlays(copies);
  let overlayReads = 0;
  let t = performance.now();
  const api = new API({
    cwd: dirname(FIXTURE_TSCONFIG),
    fs: {
      readFile: (f) => {
        const text = overlays.get(f);
        if (text !== undefined) overlayReads++;
        return text;
      },
      fileExists: (f) => (overlays.has(f) ? true : undefined),
      directoryExists: (d) => (copies > 0 && d === GEN ? true : undefined),
      getAccessibleEntries: (d) => {
        if (copies === 0) return undefined;
        if (d === GEN) {
          const files = [...overlays.keys()].filter((f) => dirname(f) === GEN);
          return { files: files.map((f) => f.slice(GEN.length + 1)), directories: [] };
        }
        if (d === SRC) return { files: readdirSync(SRC), directories: ["gen"] };
        return undefined;
      },
    },
  });
  const snapshot = api.updateSnapshot({ openProjects: [FIXTURE_TSCONFIG] });
  const project = snapshot.getProject(FIXTURE_TSCONFIG);
  if (!project) throw new Error("tsgo did not load the fixture project");
  const tOpen = performance.now() - t;

  const answers = new Map<string, FromSet>();
  t = performance.now();
  const byFile = new Map<string, Probe[]>();
  for (const p of probes) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
  for (const [file, mine] of byFile) {
    const types = project.checker.getTypeAtPosition(
      file,
      mine.map((p) => p.pos),
    );
    mine.forEach((p, i) => {
      const ty = types[i] as Ts7Type | undefined;
      if (file.startsWith(GEN)) return; // copies: timing only
      answers.set(p.caseId, ty ? literals7(ty) : "*");
    });
  }
  const tQuery = performance.now() - t;
  const files = project.program.getSourceFileNames().length;
  api.close();
  const overlayCount = overlays.size;
  return { answers, tOpen, tQuery, probes: probes.length, files, overlayReads, overlayCount };
}
