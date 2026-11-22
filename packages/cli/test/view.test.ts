import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import type { ViewData } from "@tsverify/viewer";
import { afterEach, describe, expect, it } from "vitest";
import { formatUrls, watchList } from "../src/commands/view";
import { type Io, main } from "../src/main";
import { tsv } from "./run";
import { tempSpecDir } from "./temp-specs";

const SPEC = `behavior: Light
entity:
  name: Light
  state: status
  states: [off, on]
  initial: off
  terminal: [on]
actors:
  user: { trust: authenticated }
transitions:
  switch_on:
    from: off
    to: on
    by: user
    impl: src/light.ts#switchOn
`;

const CODE = `export interface Light {
  id: string;
  status: "off" | "on";
}

export function switchOn(light: Light): void {
  if (light.status !== "off") throw new Error("not off");
  light.status = "on";
}
`;

const TSCONFIG = `{ "compilerOptions": { "strict": true, "noEmit": true }, "include": ["src"] }\n`;

function project(): Promise<string> {
  return tempSpecDir({
    "tsconfig.json": TSCONFIG,
    "src/light.ts": CODE,
    "src/light.behavior.yaml": SPEC,
  });
}

/** `tsv view` running in-process: its output so far, and a way to interrupt it. */
interface Running {
  url: Promise<string>;
  stderr(): string;
  /** Waits until stderr contains `text`. */
  waitForStderr(text: string): Promise<void>;
  interrupt(): void;
  exit: Promise<number>;
}

const running: Running[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    r.interrupt();
    await r.exit;
  }
});

function view(argv: string[], cwd: string): Running {
  let stdout = "";
  let stderr = "";
  let onUrl: (url: string) => void = () => {};
  const url = new Promise<string>((resolve) => {
    onUrl = resolve;
  });
  const listeners = new Set<() => void>();
  const waiters: { text: string; resolve: () => void }[] = [];
  const io: Io = {
    stdout: (s) => {
      stdout += s;
      const m = stdout.match(/http:\/\/\S+\//);
      if (m) onUrl(m[0]);
    },
    stderr: (s) => {
      stderr += s;
      for (const w of [...waiters]) {
        if (stderr.includes(w.text)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
      }
    },
    cwd,
    isTTY: false,
    env: {},
    onInterrupt: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const r: Running = {
    url,
    stderr: () => stderr,
    waitForStderr: (text) =>
      new Promise((resolve) => {
        if (stderr.includes(text)) resolve();
        else waiters.push({ text, resolve });
      }),
    interrupt: () => {
      for (const l of [...listeners]) l();
    },
    exit: main(["view", ...argv], io),
  };
  running.push(r);
  return r;
}

async function getData(url: string): Promise<ViewData> {
  const res = await fetch(`${url}api/data`);
  expect(res.status).toBe(200);
  return (await res.json()) as ViewData;
}

describe("formatUrls", () => {
  it("prints the local URL and the SSH command for other machines, no network addresses", () => {
    expect(formatUrls("http://127.0.0.1:4400/", 4400)).toBe(
      [
        "tsv view",
        "  Local:    http://127.0.0.1:4400/",
        "  Remote:   ssh -N -L 4400:127.0.0.1:4400 <user>@<this machine>, then open http://localhost:4400/",
        "",
      ].join("\n"),
    );
  });
});

describe("tsv view", () => {
  it("documents its flags", async () => {
    const r = await tsv(["view", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("$ tsv view [...paths] [options]");
    expect(r.stdout).toMatch(/--port <n> +Port to listen on; 0 picks a free one \(default: 0\)/);
    expect(r.stdout).toMatch(/--host <address> .*\(default: 127\.0\.0\.1\)/);
    expect(r.stdout).toMatch(/--open +Open the viewer in the default browser/);
    expect(r.stdout).toMatch(/--spec-only/);
    expect(r.stdout).toMatch(/--project <dir>/);
  });

  it("refuses a non-loopback --host with exit 2 and points to SSH forwarding", async () => {
    const r = await tsv(["view", "--host", "0.0.0.0"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--host must be a loopback address");
    expect(r.stderr).toContain("forward the port over SSH");
  });

  it("serves check's results, rebuilds on a code change, and stops when interrupted", async () => {
    const dir = await project();
    const r = view(["."], dir);
    const url = await r.url;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const data = await getData(url);
    expect(data.version).toBe(1);
    expect(data.specOnly).toBe(false);
    expect(data.specs).toHaveLength(1);
    const [spec] = data.specs;
    expect(spec?.file).toBe("src/light.behavior.yaml");
    expect(spec?.project).toBe(".");
    expect(spec?.findings).toEqual([]);
    expect(spec?.code?.origin).toBe("code");
    expect(spec?.code?.transitions[0]?.sites?.write.file).toBe("src/light.ts");
    expect(spec?.mermaid.spec).toContain("off --> on: switch_on · user");

    // Drop the guard: the rebuilt data has the conformance finding.
    await writeFile(join(dir, "src/light.ts"), CODE.replace(/ {2}if \(light.*\n/, ""));
    await r.waitForStderr("tsv view: rebuilt (build 2");
    const rebuilt = await getData(url);
    expect(rebuilt.version).toBe(2);
    expect(rebuilt.specs[0]?.findings.map((f) => f.category)).toContain("from-state-unconstrained");

    r.interrupt();
    expect(await r.exit).toBe(0);
    expect(r.stderr()).toContain("tsv view: stopped");
    await expect(fetch(`${url}api/data`)).rejects.toThrow();
  });

  it("runs --spec-only without a project", async () => {
    const dir = await tempSpecDir({ "light.behavior.yaml": SPEC });
    const r = view(["--spec-only"], dir);
    const data = await getData(await r.url);
    expect(data.specOnly).toBe(true);
    expect(data.specs[0]?.project).toBeNull();
    expect(data.specs[0]?.code).toBeUndefined();
  });

  it("rejects a bad port and a directory without specs with exit 2", async () => {
    const dir = await tempSpecDir({ "README.md": "nothing here\n" });
    const bad = await tsv(["view", "--port", "70000"], { cwd: dir });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--port must be an integer from 0 to 65535");
    const empty = await tsv(["view", "."], { cwd: dir });
    expect(empty.code).toBe(2);
    expect(empty.stderr).toContain("no *.behavior.yaml files found");
  });

  it("reports a port that is already taken as a usage error", async () => {
    const dir = await tempSpecDir({ "light.behavior.yaml": SPEC });
    const taken = createServer();
    await new Promise<void>((done) => taken.listen(0, "127.0.0.1", done));
    try {
      const port = (taken.address() as AddressInfo).port;
      const r = await tsv(["view", "--spec-only", "--port", String(port)], { cwd: dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(`cannot listen on 127.0.0.1:${port} (EADDRINUSE)`);
    } finally {
      await new Promise((done) => taken.close(done));
    }
  });

  it("watches each spec and its project's src", () => {
    const data: ViewData = {
      version: 1,
      cwd: "/work",
      specOnly: false,
      specs: [
        { file: "a/x.behavior.yaml", project: null, findings: [], mermaid: {} },
        { file: "b/src/y.behavior.yaml", project: "b", findings: [], mermaid: {} },
      ],
    };
    // `/work/b/src` does not exist here, so the project root is watched instead.
    expect(watchList(data)).toEqual(
      ["a/x.behavior.yaml", "b/src/y.behavior.yaml", "b"].map((p) => resolve("/work", p)),
    );
  });
});
