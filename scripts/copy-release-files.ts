/**
 * `prepack` helper for the published packages: copies the repository's LICENSE, NOTICE and
 * CHANGELOG.md (and, with `--readme`, README.md) into the package being packed (the cwd). The
 * copies are gitignored.
 *
 *   tsx ../../scripts/copy-release-files.ts [--readme]
 */
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = ["LICENSE", "NOTICE", "CHANGELOG.md"];
if (process.argv.includes("--readme")) files.push("README.md");

for (const file of files) copyFileSync(join(root, file), join(process.cwd(), file));
