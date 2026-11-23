/**
 * One TypeScript 7 compiler process for one tsconfig project, through the synchronous API.
 *
 * The extractor needs the project twice (X1 probe-first injection): as on disk, for syntactic
 * discovery, then with the probed text of some files, for type queries. Both are snapshots of
 * the same process; the second only re-reads the probed files, and every other `SourceFile`
 * object carries over unchanged, so nodes of unprobed files are the same in both.
 *
 * Opening a project is the one place where 7.0 and 7.1 differ:
 * - 7.0 (`typescript/unstable/sync`): `api.updateSnapshot({ openProjects })`; probed text goes in
 *   through the API's `fs.readFile` callback, and `updateSnapshot({ fileChanges: { changed } })`
 *   makes the server read those files again.
 * - 7.1 (`typescript/sync`): `api.createSnapshot({ openProjects })`; probed text goes in as a
 *   request filesystem layer, `snapshot.update({ fileSystem: { kind: "layer", files } })`.
 *
 * `close()` ends the process. Whoever opens a session closes it, on every path.
 */
import type * as TS from "./ts-types";
import type { TypeScript } from "./typescript";

/** The 7.1 snapshot API, which the 7.0 typings this package compiles against do not have. */
interface SnapshotApi71 {
  createSnapshot(params: { openProjects: string[]; ensurePrograms: true }): Snapshot71;
}

interface Snapshot71 {
  getConfiguredProject(configFileName: string): TS.Project | undefined;
  update(params: {
    fileSystem: { kind: "layer"; files: Record<string, string> };
    ensurePrograms: true;
  }): Snapshot71;
}

export class CompilerSession {
  private readonly api: TS.API;
  /** 7.1+: the API has `createSnapshot`. */
  private readonly api71: SnapshotApi71 | undefined;
  /** Text served in place of a file's own (7.0 `readFile` callback). */
  private readonly overlay = new Map<string, string>();
  private snapshot71: Snapshot71 | undefined;
  private closed = false;

  /** Starts the compiler process. */
  constructor(
    typescript: TypeScript,
    root: string,
    private readonly configPath: string,
  ) {
    const { API } = typescript.sync;
    // A getter on 7.1's prototype, so tested with `in` (reading it there would call it).
    if ("createSnapshot" in API.prototype) {
      // 7.1's `fs` callbacks stand for the whole host file system (`undefined` = no such
      // file), so none are passed: probed text goes in as a snapshot layer instead.
      this.api = new API({ cwd: root });
      this.api71 = this.api as unknown as SnapshotApi71;
    } else {
      // 7.0: a callback result of `undefined` falls back to the real file system.
      this.api = new API({ cwd: root, fs: { readFile: (name) => this.overlay.get(name) } });
    }
  }

  private project(found: TS.Project | undefined): TS.Project {
    if (!found) throw new Error(`extractor: TypeScript did not open ${this.configPath}`);
    return found;
  }

  /** The project as on disk. */
  open(): TS.Project {
    if (this.api71) {
      this.snapshot71 = this.api71.createSnapshot({
        openProjects: [this.configPath],
        ensurePrograms: true,
      });
      return this.project(this.snapshot71.getConfiguredProject(this.configPath));
    }
    const snapshot = this.api.updateSnapshot({ openProjects: [this.configPath] });
    return this.project(snapshot.getProject(this.configPath));
  }

  /** The project with `files` (absolute path → text) in place of those files on disk. */
  openWith(files: ReadonlyMap<string, string>): TS.Project {
    if (this.snapshot71) {
      this.snapshot71 = this.snapshot71.update({
        fileSystem: { kind: "layer", files: Object.fromEntries(files) },
        ensurePrograms: true,
      });
      return this.project(this.snapshot71.getConfiguredProject(this.configPath));
    }
    for (const [name, text] of files) this.overlay.set(name, text);
    const snapshot = this.api.updateSnapshot({ fileChanges: { changed: [...files.keys()] } });
    return this.project(snapshot.getProject(this.configPath));
  }

  /** Ends the compiler process. Safe to call more than once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.api.close();
  }
}
