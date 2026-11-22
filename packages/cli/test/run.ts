import { fileURLToPath } from "node:url";
import { type Io, main } from "../src/main";

/** Repository root: the default cwd for in-process runs, so locations read like a user's. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The canonical example spec directory (golden input shared by every package). */
export const CANONICAL_DIR = "packages/spec/test/fixtures/valid";
export const CANONICAL_SPEC = `${CANONICAL_DIR}/order.behavior.yaml`;
/** An invalid spec: `ship.to` names an undeclared state (line 18, column 9). */
export const INVALID_SPEC = "packages/cli/test/fixtures/invalid/typo.behavior.yaml";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  isTTY?: boolean;
  env?: Record<string, string | undefined>;
}

/** Runs `tsverify <argv>` in-process against a fake `Io` and captures its output. */
export async function tsverify(argv: string[], options: RunOptions = {}): Promise<RunResult> {
  let stdout = "";
  let stderr = "";
  const io: Io = {
    stdout: (s) => {
      stdout += s;
    },
    stderr: (s) => {
      stderr += s;
    },
    cwd: options.cwd ?? REPO_ROOT,
    isTTY: options.isTTY ?? false,
    env: options.env ?? {},
  };
  const code = await main(argv, io);
  return { code, stdout, stderr };
}
