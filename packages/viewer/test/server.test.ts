import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAllowedHost, isLoopback } from "../src/server/host-guard";
import { openBrowser, openerCommand } from "../src/server/open";
import { startViewer, type Viewer, type ViewerOptions } from "../src/server/server";
import { watchPaths } from "../src/server/watch";
import type { ViewData } from "../src/view-data";

const viewers: Viewer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(viewers.splice(0).map((v) => v.close()));
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tsverify-viewer-"));
  dirs.push(dir);
  return dir;
}

function data(cwd: string): ViewData {
  return { version: 0, cwd, specOnly: true, specs: [] };
}

async function start(options: Partial<ViewerOptions> = {}): Promise<Viewer> {
  const viewer = await startViewer({
    load: async () => data("/demo"),
    watch: [],
    port: 0,
    ...options,
  });
  viewers.push(viewer);
  return viewer;
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** A raw HTTP request, so the `Host` header can be anything. */
function get(viewer: Viewer, path: string, init: { host?: string; method?: string } = {}) {
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        host: viewer.host,
        port: viewer.port,
        path,
        method: init.method ?? "GET",
        headers: { host: init.host ?? `${viewer.host}:${viewer.port}` },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Opens `/api/events` and resolves with the text received once it contains `until`. */
function events(viewer: Viewer) {
  let text = "";
  const waiters: { until: string; resolve: (t: string) => void }[] = [];
  const req = request({
    host: viewer.host,
    port: viewer.port,
    path: "/api/events",
    headers: { host: `localhost:${viewer.port}` },
  });
  const opened = new Promise<void>((resolve, reject) => {
    req.on("response", (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        text += chunk;
        for (const w of [...waiters]) {
          if (text.includes(w.until)) {
            waiters.splice(waiters.indexOf(w), 1);
            w.resolve(text);
          }
        }
        if (text.includes("retry:")) resolve();
      });
    });
    req.on("error", reject);
  });
  req.end();
  return {
    opened,
    next: (until: string) =>
      new Promise<string>((resolve) => {
        if (text.includes(until)) resolve(text);
        else waiters.push({ until, resolve });
      }),
    close: () => req.destroy(),
  };
}

describe("startViewer", () => {
  it("binds to 127.0.0.1 on a free port and serves the data", async () => {
    const viewer = await start();
    expect(viewer.host).toBe("127.0.0.1");
    expect(viewer.port).toBeGreaterThan(0);
    expect(viewer.url).toBe(`http://127.0.0.1:${viewer.port}/`);
    const res = await get(viewer, "/api/data");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(res.body)).toEqual({ ...data("/demo"), version: 1 });
  });

  it("answers loopback names on any port (port-forwarding tunnels)", async () => {
    const viewer = await start();
    for (const host of [
      `localhost:${viewer.port}`,
      "localhost:9000",
      "127.0.0.1:1",
      "[::1]:9000",
    ]) {
      const res = await get(viewer, "/api/data", { host });
      expect(res.status, host).toBe(200);
    }
  });

  it("rejects any other Host header with 403 (DNS rebinding)", async () => {
    const viewer = await start();
    for (const host of [
      `evil.example:${viewer.port}`,
      "evil.example",
      `localhost.evil.example:${viewer.port}`,
      `t3-sessions:${viewer.port}`,
    ]) {
      const res = await get(viewer, "/api/data", { host });
      expect(res.status, host).toBe(403);
      expect(res.body).not.toContain("/demo");
    }
  });

  it("refuses to listen beyond loopback", async () => {
    for (const host of ["0.0.0.0", "::", "10.0.0.5"]) {
      await expect(start({ host })).rejects.toThrow(/not a loopback address/);
    }
  });

  it("serves the page, the app bundle and Mermaid from the package, with a strict CSP", async () => {
    const viewer = await start();
    const page = await get(viewer, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain('<script type="module" src="/app.js"></script>');
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("script-src 'self'");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const app = await get(viewer, "/app.js");
    expect(app.status).toBe(200);
    expect(app.headers["content-type"]).toMatch(/^text\/javascript/);
    expect(app.body).toContain("/vendor/mermaid/mermaid.esm.min.mjs");
    expect(app.body).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost|www\.w3\.org)[a-z]/i);

    const mermaid = await get(viewer, "/vendor/mermaid/mermaid.esm.min.mjs");
    expect(mermaid.status).toBe(200);
    expect(mermaid.body).toContain("./chunks/mermaid.esm.min/");
  });

  it("404s paths outside the served Mermaid files and 405s non-GET methods", async () => {
    const viewer = await start();
    for (const path of [
      "/vendor/mermaid/../package.json",
      "/vendor/mermaid/%2e%2e/package.json",
      "/vendor/mermaid/mermaid.js",
      "/vendor/mermaid/chunks/mermaid.esm.min/..%2f..%2fmermaid.js",
      "/package.json",
    ]) {
      expect((await get(viewer, path)).status, path).toBe(404);
    }
    expect((await get(viewer, "/api/data", { method: "POST" })).status).toBe(405);
  });

  it("sends a reload event after a watched file changes, then serves the rebuilt data", async () => {
    const dir = await tempDir();
    const file = join(dir, "x.behavior.yaml");
    await writeFile(file, "one");
    const reloads: number[] = [];
    const viewer = await start({
      load: async () => data(await readFile(file, "utf8")),
      watch: [dir],
      debounceMs: 20,
      onReload: (e) => reloads.push(e.version),
    });
    const stream = events(viewer);
    await stream.opened;
    await writeFile(file, "two");
    const text = await stream.next("event: reload");
    stream.close();
    expect(text).toContain('data: {"version":2}');
    expect(reloads[0]).toBe(2);
    const res = JSON.parse((await get(viewer, "/api/data")).body) as ViewData;
    expect([res.version, res.cwd]).toEqual([2, "two"]);
  });

  it("keeps the last good data and reports the error when a rebuild fails", async () => {
    let fail = false;
    const viewer = await start({
      load: async () => {
        if (fail) throw new Error("no *.behavior.yaml files found in .");
        return data("/good");
      },
    });
    fail = true;
    await viewer.reload();
    expect(viewer.data()).toMatchObject({
      version: 2,
      cwd: "/good",
      error: "no *.behavior.yaml files found in .",
    });
    fail = false;
    await viewer.reload();
    expect(viewer.data().error).toBeUndefined();
  });

  it("re-reads a watch function after each rebuild", async () => {
    const seen: number[] = [];
    const viewer = await start({
      watch: (d) => {
        seen.push(d.version);
        return [];
      },
    });
    await viewer.reload();
    expect(seen).toEqual([1, 2]);
  });

  it("rejects when the first load fails", async () => {
    await expect(
      startViewer({ load: () => Promise.reject(new Error("bad input")), watch: [], port: 0 }),
    ).rejects.toThrow("bad input");
  });

  it("closes open event streams and stops listening; close is idempotent", async () => {
    const viewer = await start();
    const stream = events(viewer);
    await stream.opened;
    await Promise.all([viewer.close(), viewer.close()]);
    await expect(get(viewer, "/api/data")).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("watchPaths", () => {
  it("debounces a burst of changes into one call, and ignores node_modules", async () => {
    const dir = await tempDir();
    await writeFile(join(dir, "a.ts"), "");
    let calls = 0;
    const changed = new Promise<void>((resolve) => {
      const w = watchPaths(
        [dir],
        () => {
          calls += 1;
          setTimeout(() => {
            w.close();
            resolve();
          }, 100);
        },
        { debounceMs: 30 },
      );
    });
    await writeFile(join(dir, "a.ts"), "1");
    await writeFile(join(dir, "a.ts"), "2");
    await changed;
    expect(calls).toBe(1);
  });

  it("polls when asked to", async () => {
    const dir = await tempDir();
    const file = join(dir, "spec.behavior.yaml");
    await writeFile(file, "a");
    let w: { close(): void } | undefined;
    const changed = new Promise<void>((resolve) => {
      w = watchPaths([file], resolve, { poll: true, pollMs: 20, debounceMs: 10 });
    });
    await new Promise((r) => setTimeout(r, 30));
    await writeFile(file, "bb");
    await changed;
    w?.close();
  });
});

describe("host guard", () => {
  it("allows loopback names on any port, nothing else", () => {
    for (const h of [
      "127.0.0.1:4000",
      "LOCALHOST:9000",
      "localhost",
      "[::1]:4000",
      "127.1.2.3:1",
    ]) {
      expect(isAllowedHost(h), h).toBe(true);
    }
    for (const h of [
      "0.0.0.0:4000",
      "10.0.0.5:4000",
      "t3-sessions:4000",
      "localhost.evil.example:4000",
      "evil.example",
      "localhost:4000@evil",
    ]) {
      expect(isAllowedHost(h), h).toBe(false);
    }
    expect(isAllowedHost(undefined)).toBe(false);
  });

  it("knows loopback addresses", () => {
    expect(["127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost"].every(isLoopback)).toBe(true);
    expect(["0.0.0.0", "192.168.1.2", "::"].some(isLoopback)).toBe(false);
  });
});

describe("openBrowser", () => {
  it("uses the platform opener", () => {
    const url = "http://127.0.0.1:1234/";
    expect(openerCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(openerCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(openerCommand(url, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", '""', url],
    });
  });

  it("reports a missing opener instead of throwing", () => {
    const errors: string[] = [];
    openBrowser("http://127.0.0.1:1/", {
      platform: "linux",
      spawn: () => {
        throw new Error("spawn xdg-open ENOENT");
      },
      onError: (e) => errors.push(e.message),
    });
    expect(errors).toEqual(["spawn xdg-open ENOENT"]);
  });
});
