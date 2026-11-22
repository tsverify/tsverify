import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/**
 * Commits in temp repositories are made with a fixed identity and date and without the user's
 * git config, so hashes are reproducible and a global `commit.gpgsign` cannot get in the way.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "tsv test",
  GIT_AUTHOR_EMAIL: "tsv@example.invalid",
  GIT_COMMITTER_NAME: "tsv test",
  GIT_COMMITTER_EMAIL: "tsv@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

/** Runs `git <args>` in `dir` and returns its stdout. */
export async function git(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)("git", args, { cwd: dir, env: GIT_ENV });
  return stdout;
}

/** Writes `files` (relative path → text) under `dir`; `null` deletes the file. */
export async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [path, text] of Object.entries(files)) {
    const target = join(dir, path);
    if (text === null) {
      await rm(target, { force: true });
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, text);
  }
}

/** Makes `dir` a git repository whose one commit (on `main`) holds everything in it. */
export async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "--quiet", "--initial-branch=main");
  await git(dir, "add", "--all");
  await git(dir, "commit", "--quiet", "--no-verify", "-m", "base");
}
