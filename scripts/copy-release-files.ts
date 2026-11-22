/**
 * `prepack` helper for the published packages: copies the repository's LICENSE, NOTICE and
 * CHANGELOG.md (and, with `--readme`, README.md) into the package being packed (the cwd). The
 * copies are gitignored. The README's relative links and images point into the repository, so
 * they are rewritten to absolute GitHub URLs that still work on npmjs.com.
 *
 *   tsx ../../scripts/copy-release-files.ts [--readme]
 */
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const files = ["LICENSE", "NOTICE", "CHANGELOG.md"];
for (const file of files) copyFileSync(join(root, file), join(process.cwd(), file));

const REPO = "https://github.com/tsverify/tsverify";

/** Relative Markdown links and `src="…"` images → absolute GitHub URLs (blob for pages, raw for images). */
function absolutizeLinks(markdown: string): string {
  const relative = (url: string) => !/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(url);
  return markdown
    .replace(/\]\(([^)\s]+)\)/g, (m, url: string) =>
      relative(url) ? `](${REPO}/blob/main/${url})` : m,
    )
    .replace(/src="([^"]+)"/g, (m, url: string) =>
      relative(url) ? `src="${REPO}/raw/main/${url}"` : m,
    );
}

if (process.argv.includes("--readme")) {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  writeFileSync(join(process.cwd(), "README.md"), absolutizeLinks(readme));
}
