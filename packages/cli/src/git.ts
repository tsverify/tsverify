import { execFile } from "node:child_process";

/**
 * Read-only access to the local `git` binary, for `tsverify diff`. Every call runs in the repository
 * root, so paths in and out are repository-relative with `/` separators. Nothing here writes to
 * the repository or the network.
 */

/** git is missing, the cwd is not in a repository, or a ref or path does not resolve. Exit 2. */
export class GitError extends Error {
  override readonly name = "GitError";
}

interface GitFailure {
  code?: number | string;
  stderr?: string;
}

function run(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, env: { ...process.env, LC_ALL: "C" } },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stderr }));
        else resolve(stdout);
      },
    );
  });
}

function reason(e: unknown): string {
  const failure = e as GitFailure;
  const text = failure.stderr?.trim().split("\n")[0];
  return text === undefined || text === "" ? String(e) : text;
}

function isMissingGit(e: unknown): boolean {
  return (e as GitFailure).code === "ENOENT";
}

/** Absolute path of the repository's top-level directory (symlinks resolved, as git reports it). */
export async function repoRoot(cwd: string): Promise<string> {
  try {
    return (await run(["rev-parse", "--show-toplevel"], cwd)).trim();
  } catch (e) {
    if (isMissingGit(e)) throw new GitError("git not found on PATH");
    throw new GitError(`not in a git repository: ${cwd} (${reason(e)})`);
  }
}

/** The commit `ref` names (full hash). Throws `GitError` for anything that is not a commit. */
export async function resolveCommit(root: string, ref: string): Promise<string> {
  if (ref === "" || ref.startsWith("-")) throw new GitError(`not a git ref: "${ref}"`);
  try {
    const out = await run(
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      root,
    );
    return out.trim();
  } catch {
    throw new GitError(`unknown git ref "${ref}" (no such branch, tag or commit)`);
  }
}

/** Files (blobs) under `pathspecs` at `commit`, repository-relative, in git's order. */
export async function listFiles(
  root: string,
  commit: string,
  pathspecs: readonly string[],
): Promise<string[]> {
  try {
    const out = await run(["ls-tree", "-r", "-z", "--name-only", commit, "--", ...pathspecs], root);
    return out.split("\0").filter((f) => f !== "");
  } catch (e) {
    throw new GitError(`git ls-tree ${commit} failed: ${reason(e)}`);
  }
}

/** The contents of `path` (repository-relative) at `commit`. */
export async function showFile(root: string, commit: string, path: string): Promise<string> {
  try {
    return await run(["show", `${commit}:${path}`], root);
  } catch (e) {
    throw new GitError(`git show ${commit}:${path} failed: ${reason(e)}`);
  }
}
