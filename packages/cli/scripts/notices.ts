/**
 * `dist/THIRD_PARTY_NOTICES.md` for the published CLI: the name, version, license and license
 * text of every third-party package bundled into `dist/` (`scripts/build.ts`). Their licenses
 * (MIT, ISC, BSD) require shipping the copyright notice and license text with the code.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface NoticePackage {
  name: string;
  version: string;
  /** The installed package directory, holding its `package.json` and license file(s). */
  dir: string;
  /** Published files the package's code is bundled into, e.g. `dist/tsverify.js`. */
  bundledIn: string[];
}

/** `LICENSE`, `LICENSE.md`, `license.txt`, `LICENCE`, `LICENSE-MPL`, `COPYING`… */
const LICENSE_FILE = /^(?:licen[cs]e|copying)(?:[.-].*)?$/i;

/** The license files of a package directory, sorted. Throws when there are none. */
export function licenseFiles(dir: string): string[] {
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort();
  if (files.length === 0) throw new Error(`no license file in ${dir}`);
  return files;
}

function licenseName(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    license?: unknown;
    licenses?: { type?: unknown }[];
  };
  if (typeof manifest.license === "string") return manifest.license;
  const types = (manifest.licenses ?? []).map((l) => l.type).filter((t) => typeof t === "string");
  return types.length > 0 ? types.join(" OR ") : "see the license text";
}

/** A fence longer than any backtick run in `text`, so the text is reproduced verbatim. */
function fence(text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(longest + 1);
}

/** The notices document. Packages are listed by name; one entry per name and version. */
export function thirdPartyNotices(packages: readonly NoticePackage[]): string {
  const unique = new Map<string, NoticePackage>();
  for (const p of packages) {
    const key = `${p.name}@${p.version}`;
    const seen = unique.get(key);
    unique.set(key, {
      ...p,
      bundledIn: [...new Set([...(seen?.bundledIn ?? []), ...p.bundledIn])].sort(),
    });
  }
  const sorted = [...unique.values()].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : a.version < b.version ? -1 : 1,
  );
  const out = [
    "# Third-party notices",
    "",
    "`@tsverify/cli` bundles the following open-source packages into its `dist/` files. Each is",
    "used under its own license, reproduced below. tsverify itself is licensed under Apache-2.0",
    "(`LICENSE`, `NOTICE`).",
    "",
    ...sorted.map((p) => `- ${p.name} ${p.version} (${licenseName(p.dir)})`),
    "",
  ];
  for (const p of sorted) {
    out.push(`## ${p.name} ${p.version}`, "");
    out.push(`License: ${licenseName(p.dir)}. Bundled into ${p.bundledIn.join(", ")}.`, "");
    for (const file of licenseFiles(p.dir)) {
      const text = readFileSync(join(p.dir, file), "utf8").replace(/\r\n/g, "\n").trimEnd();
      const f = fence(text);
      out.push(`${file}:`, "", `${f}text`, text, f, "");
    }
  }
  return out.join("\n");
}
