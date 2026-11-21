// Spike X1 runner: pnpm exec tsx spikes/x1-narrowing/run.ts
// Prints expected vs. actual from-sets for every fixture case and technique, then timings.
// X1_SCALE=<n> sets the number of synthetic fixture copies for the scaling run (default 100).

import { performance } from "node:perf_hooks";
import type { Project } from "ts-morph";
import { type Expectation, LIMITS, REQUIRED } from "./cases.ts";
import {
  declaredDomain,
  type FromSet,
  findAllWriteSites,
  loadProject,
  probeAnswer,
  probeFirst,
  probePostHoc,
  probeType,
  renderSet,
  run,
  sameSet,
  TECHNIQUES,
  type TechniqueId,
  ts,
  type WriteSite,
} from "./narrowing.ts";
import { runTs7, type Ts7Result } from "./ts7.ts";

const SCALE = Number(process.env.X1_SCALE ?? 100);
const ms = (n: number) => `${n.toFixed(1)} ms`;
const us = (n: number) => `${(n * 1000).toFixed(0)} µs`;

function time<T>(fn: () => T): [T, number] {
  const t = performance.now();
  const r = fn();
  return [r, performance.now() - t];
}

function firstOf<T>(xs: readonly T[]): T {
  const x = xs[0];
  if (x === undefined) throw new Error("empty");
  return x;
}

const all: readonly Expectation[] = [...REQUIRED, ...LIMITS];

function checkSites(sites: readonly WriteSite[]): void {
  const seen = new Set<string>();
  for (const s of sites) {
    if (seen.has(s.caseId)) throw new Error(`more than one write in ${s.caseId}`);
    seen.add(s.caseId);
  }
  for (const e of all) if (!seen.has(e.caseId)) throw new Error(`no write found in ${e.caseId}`);
}

console.log(`ts-morph bundles TypeScript ${ts.version}\n`);

// Warm-up: the first project in a process pays module init, lib-file loading and JIT.
const [, coldFullCheck] = time(() => loadProject().getPreEmitDiagnostics());

interface Timing {
  load: number;
  first: number;
  avgRest: number;
}
const answers = new Map<TechniqueId, Map<string, FromSet>>();
const timings = new Map<TechniqueId, Timing>();
let domains = new Map<string, FromSet>();
let recheck = { batch: 0, perSite: 0, sites: 0 };

// --- T0, T1, T3, T4: each on a fresh, pristine project --------------------------------------
for (const { id } of TECHNIQUES) {
  if (id === "probe") continue;
  const [project, load] = time(() => loadProject());
  const sites = findAllWriteSites(project);
  checkSites(sites);
  const m = new Map<string, FromSet>();
  const head = firstOf(sites);
  const [, first] = time(() => m.set(head.caseId, run(project, id, head)));
  const [, rest] = time(() => {
    for (const s of sites.slice(1)) m.set(s.caseId, run(project, id, s));
  });
  answers.set(id, m);
  timings.set(id, { load, first, avgRest: rest / (sites.length - 1) });

  if (id === "naive") {
    domains = new Map(sites.map((s) => [s.caseId, declaredDomain(project, s)]));
    // Post-hoc probes on an already-checked program: what re-checking costs.
    const [, batch] = time(() => probePostHoc(project, sites));
    const [, perSiteTotal] = time(() => {
      for (const s of sites) probePostHoc(project, [s]);
    });
    recheck = { batch, perSite: perSiteTotal / sites.length, sites: sites.length };
  }
}

// --- T2: probe-first (inject before the first checker query) --------------------------------
const probeTypes = new Map<string, string>();
let probedDiagnostics: string[] = [];
{
  const [project, load] = time(() => loadProject());
  const [sites, inject] = time(() => probeFirst(project));
  checkSites(sites);
  const m = new Map<string, FromSet>();
  const head = firstOf(sites);
  const [, first] = time(() => m.set(head.caseId, probeAnswer(project, head)));
  const [, rest] = time(() => {
    for (const s of sites.slice(1)) m.set(s.caseId, probeAnswer(project, s));
  });
  answers.set("probe", m);
  timings.set("probe", { load: load + inject, first, avgRest: rest / (sites.length - 1) });
  const checker = project.getTypeChecker().compilerObject;
  for (const s of sites) probeTypes.set(s.caseId, checker.typeToString(probeType(project, s)));
  probedDiagnostics = project.getPreEmitDiagnostics().map((d) => `TS${d.getCode()}`);

  // Post-hoc probes must agree with probe-first.
  const pristine = loadProject();
  const pristineSites = findAllWriteSites(pristine);
  for (const [site, got] of probePostHoc(pristine, pristineSites)) {
    const want = m.get(site.caseId);
    if (!want || !sameSet(got, want)) throw new Error(`post-hoc disagrees on ${site.caseId}`);
  }
}

// --- T2 on TypeScript 7 (tsgo) through its unstable sync API ---------------------------------
let ts7: Ts7Result | undefined;
try {
  ts7 = runTs7(0);
} catch (err) {
  console.log(`tsgo backend unavailable: ${String(err)}\n`);
}

// --- results ----------------------------------------------------------------------------------
function table(title: string, rows: readonly Expectation[]) {
  console.log(`### ${title}\n`);
  const ids = TECHNIQUES.map((t) => t.label.split(" ")[0]);
  const head = ["case", "expected", ...ids, "T2 on tsgo", "T2 raw type (TS 6)"];
  console.log(`| ${head.join(" | ")} |`);
  console.log(`|${head.map(() => "---").join("|")}|`);
  const score = new Map<TechniqueId | "tsgo", number>();
  for (const e of rows) {
    const domain = domains.get(e.caseId) ?? "*";
    const truth = e.truth ? ` (truth ${renderSet(e.truth, domain)})` : "";
    const cells = TECHNIQUES.map(({ id }) => {
      const got = answers.get(id)?.get(e.caseId) ?? "*";
      const ok = sameSet(got, e.expected);
      if (ok) score.set(id, (score.get(id) ?? 0) + 1);
      return `${ok ? "ok" : "**X**"} ${renderSet(got, domain)}`;
    });
    const got7 = ts7?.answers.get(e.caseId);
    const ok7 = got7 !== undefined && sameSet(got7, e.expected);
    if (ok7) score.set("tsgo", (score.get("tsgo") ?? 0) + 1);
    cells.push(got7 === undefined ? "n/a" : `${ok7 ? "ok" : "**X**"} ${renderSet(got7, domain)}`);
    const raw = `\`${probeTypes.get(e.caseId)?.replaceAll("|", "\\|")}\``;
    console.log(
      `| ${e.title} | ${renderSet(e.expected, domain)}${truth} | ${cells.join(" | ")} | ${raw} |`,
    );
  }
  const totals = [...TECHNIQUES.map((t) => t.id), "tsgo" as const].map(
    (id) => `**${score.get(id) ?? 0}/${rows.length}**`,
  );
  console.log(`| **score** | | ${totals.join(" | ")} | |\n`);
}

console.log("Techniques:");
for (const t of TECHNIQUES) console.log(`  ${t.label}`);
console.log(
  "\nALL = the full declared union (reported as unconstrained); * = not a finite literal set.\n",
);
table("Required cases", REQUIRED);
table("Limits", LIMITS);

// --- timings on the fixture --------------------------------------------------------------------
console.log("### Timings: fixture (3 files, one fresh project per technique, after warm-up)\n");
console.log(`Cold process, first project: load + full check = ${ms(coldFullCheck)}\n`);
console.log("| technique | project load | first query | per-query avg (rest) |");
console.log("|---|---|---|---|");
for (const { id, label } of TECHNIQUES) {
  const t = timings.get(id);
  if (!t) continue;
  const load = id === "probe" ? `${ms(t.load)} (incl. inject)` : ms(t.load);
  console.log(`| ${label} | ${load} | ${ms(t.first)} | ${us(t.avgRest)} |`);
}
console.log("");
console.log("| probe re-check (post-hoc, after the program was already checked) | time |");
console.log("|---|---|");
console.log(`| batched: all ${recheck.sites} sites, 1 rebuild + queries | ${ms(recheck.batch)} |`);
console.log(`| per site: 1 rebuild + 1 query, average | ${ms(recheck.perSite)} |`);
if (ts7) {
  console.log("");
  console.log("| T2 on tsgo (TS 7.0.2 native, sync API) | time |");
  console.log("|---|---|");
  console.log(`| spawn tsgo + open project (probed files via virtual FS) | ${ms(ts7.tOpen)} |`);
  console.log(`| ${ts7.probes} probe queries, one batched call per file | ${ms(ts7.tQuery)} |`);
}

// --- scaling: N synthetic copies of the fixture ------------------------------------------------
function withCopies(n: number): Project {
  const project = loadProject();
  for (const base of ["cases", "limits"]) {
    const sf = project.getSourceFileOrThrow(`${base}.ts`);
    const text = sf.getFullText().replaceAll('"./order.js"', '"../order.js"');
    for (let i = 0; i < n; i++) {
      project.createSourceFile(`${sf.getDirectoryPath()}/gen/${base}${i}.ts`, text);
    }
  }
  return project;
}

if (SCALE > 0) {
  const [p1, load1] = time(() => withCopies(SCALE));
  const files = p1.getSourceFiles();
  const loc = files.reduce((n, f) => n + f.getEndLineNumber(), 0);
  const sites1 = findAllWriteSites(p1);
  const [p0] = time(() => withCopies(SCALE));
  const sites0 = findAllWriteSites(p0);
  const [, naiveAll] = time(() => {
    for (const s of sites0) run(p0, "naive", s);
  });
  const [, inPlace] = time(() => {
    for (const s of sites1) run(p1, "borrowedFlow", s);
  });
  const [, postHoc] = time(() => probePostHoc(p1, sites1));

  const [p2, load2] = time(() => withCopies(SCALE));
  const [sites2, inject] = time(() => probeFirst(p2));
  const [, probeQueries] = time(() => {
    for (const s of sites2) probeAnswer(p2, s);
  });

  const [, diag] = time(() => withCopies(SCALE).getPreEmitDiagnostics().length);
  const big7 = ts7 ? runTs7(SCALE) : undefined;

  console.log(
    `\n### Timings: scaling (${SCALE} copies: ${files.length} files, ${loc} lines, ${sites1.length} sites)\n`,
  );
  console.log("| measurement | time |");
  console.log("|---|---|");
  console.log(`| load (parse) | ${ms(load1)} |`);
  console.log(`| baseline T0 naive: all sites, cold checker | ${ms(naiveAll)} |`);
  console.log(`| T4 borrowed flow: all sites, cold checker | ${ms(inPlace)} |`);
  console.log(`| T2 post-hoc: 1 rebuild + all probe queries | ${ms(postHoc)} |`);
  console.log(`| T2 probe-first: load | ${ms(load2)} |`);
  console.log(`| T2 probe-first: find sites + inject + reparse | ${ms(inject)} |`);
  console.log(`| T2 probe-first: all probe queries, cold checker | ${ms(probeQueries)} |`);
  console.log(`| reference: full check (getPreEmitDiagnostics) incl. load | ${ms(diag)} |`);
  if (big7) {
    console.log(`| T2 on tsgo: spawn + open project | ${ms(big7.tOpen)} |`);
    console.log(
      `| T2 on tsgo: all ${big7.probes} probe queries (batched per file) | ${ms(big7.tQuery)} |`,
    );
  }
  const mem = process.memoryUsage().rss / 1024 / 1024;
  console.log(`\nRSS at end: ${mem.toFixed(0)} MB`);
}

// --- sanity -----------------------------------------------------------------------------------
const diags = loadProject().getPreEmitDiagnostics();
console.log(`\nFixture diagnostics: ${diags.length} (expected 0)`);
console.log(
  `Probed-program diagnostics: ${probedDiagnostics.length} ${probedDiagnostics.join(" ")}`,
);
for (const d of diags) {
  console.log(`  ${d.getSourceFile()?.getBaseName()}:${d.getLineNumber()} ${d.getMessageText()}`);
}
