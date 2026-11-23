/**
 * Renders a `tsverify view` page in a real headless Chrome and reports what the state diagram
 * looks like, for `pnpm smoke:pack`. Serving the files is not enough: a bundling mistake (a
 * Mermaid module left out) still serves every file but draws a "Syntax error" diagram.
 *
 * The browser comes from `CHROME_PATH`, else the first of a few common names on PATH. Without
 * one, `findChrome` returns undefined and the smoke test reports the check as skipped.
 * Speaks the DevTools protocol directly (Node's global WebSocket), so it needs no dependency.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
  "chrome-headless-shell",
];

export function findChrome(): string | undefined {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  for (const name of CANDIDATES) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  return undefined;
}

export interface DiagramRender {
  /** `aria-roledescription` of each rendered Mermaid SVG, e.g. `stateDiagram`. */
  diagrams: (string | null)[];
  /** Mermaid drew its "Syntax error in text" picture instead of a diagram. */
  syntaxError: boolean;
  /** State nodes drawn in the diagrams. */
  nodes: number;
  /** Console errors and uncaught exceptions on the page. */
  errors: string[];
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How long one Chrome start may take: a CI runner's first launch can be slow. */
const START_MS = 45_000;
/** Starts after the first fails: a cold start that timed out usually works the second time. */
const START_ATTEMPTS = 2;

interface Started {
  proc: ChildProcess;
  profile: string;
  port: string;
}

/**
 * Starts Chrome with a fresh profile and waits for its DevTools port. Fails early if Chrome exits,
 * and either way says what Chrome printed, so a CI log shows why it didn't start.
 */
async function startChrome(chrome: string): Promise<Started> {
  const profile = mkdtempSync(join(tmpdir(), "tsverify-chrome-"));
  const proc = spawn(
    chrome,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--no-first-run",
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr?.on("data", (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-2000);
  });
  let exited: string | undefined;
  proc.on("exit", (code, signal) => {
    exited = signal ?? `exit ${code}`;
  });
  proc.on("error", (e) => {
    exited = e.message;
  });
  const fail = (why: string): never => {
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    const said = stderr.trim().split("\n").slice(-5).join(" | ");
    throw new Error(`Chrome ${why}${said ? `; Chrome said: ${said}` : ""}`);
  };
  const start = performance.now();
  for (;;) {
    try {
      // Chrome writes the file in place: read it only once the port line is complete.
      const port = /^(\d+)\n/.exec(readFileSync(join(profile, "DevToolsActivePort"), "utf8"))?.[1];
      if (port !== undefined) return { proc, profile, port };
    } catch {
      // not written yet
    }
    if (exited !== undefined) fail(`exited before opening its DevTools port (${exited})`);
    if (performance.now() - start > START_MS) {
      fail(`opened no DevTools port within ${START_MS / 1000} s`);
    }
    await wait(100);
  }
}

/** Loads `url`, waits for the diagram to settle, and reports it. */
export async function renderDiagram(chrome: string, url: string): Promise<DiagramRender> {
  let started: Started | undefined;
  for (let attempt = 1; started === undefined; attempt++) {
    try {
      started = await startChrome(chrome);
    } catch (e) {
      if (attempt >= START_ATTEMPTS) throw e;
      process.stdout.write(`      (retrying: ${e instanceof Error ? e.message : String(e)})\n`);
    }
  }
  const { proc, profile, port } = started;
  try {
    let target: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && target === undefined; i++) {
      const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
        type: string;
        webSocketDebuggerUrl: string;
      }[];
      target = list.find((t) => t.type === "page");
      if (target === undefined) await wait(100);
    }
    if (target === undefined) throw new Error("Chrome opened no page");

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve);
      ws.addEventListener("error", reject);
    });
    const errors: string[] = [];
    const pending = new Map<number, (result: unknown) => void>();
    let next = 0;
    ws.addEventListener("message", (event) => {
      const m = JSON.parse(String(event.data));
      if (m.id !== undefined) pending.get(m.id)?.(m.result);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") {
        errors.push(m.params.args.map((a: { value?: unknown }) => String(a.value)).join(" "));
      }
      if (m.method === "Runtime.exceptionThrown") {
        errors.push(m.params.exceptionDetails.exception?.description ?? "exception");
      }
    });
    const send = (method: string, params: object = {}) =>
      new Promise<unknown>((resolve) => {
        const id = ++next;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
      });

    await send("Runtime.enable");
    await send("Page.navigate", { url });
    // Mermaid loads lazily after the data arrives; poll until a diagram is drawn (or 15 s).
    let render: Omit<DiagramRender, "errors"> = { diagrams: [], syntaxError: false, nodes: 0 };
    const start = performance.now();
    while (performance.now() - start < 15_000) {
      const result = (await send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const svgs = [...document.querySelectorAll("svg[aria-roledescription], svg[id^='mermaid']")];
          return {
            diagrams: svgs.map((s) => s.getAttribute("aria-roledescription")),
            syntaxError: (document.body?.innerText ?? "").includes("Syntax error"),
            nodes: document.querySelectorAll("svg g.node").length,
          };
        })()`,
      })) as { result?: { value?: Omit<DiagramRender, "errors"> } } | undefined;
      // Before the page has a body (still navigating), there is nothing to read yet.
      if (result?.result?.value) render = result.result.value;
      if (render.syntaxError || render.nodes > 0) break;
      await wait(250);
    }
    ws.close();
    return { ...render, errors };
  } finally {
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
  }
}
