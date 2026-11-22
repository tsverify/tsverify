import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ViewData } from "../view-data";
import { appBundle, MERMAID_PREFIX, mermaidAsset, pageHtml } from "./assets";
import { isAllowedHost, isLoopback, urlHost } from "./host-guard";
import { type Watcher, watchPaths } from "./watch";

export const DEFAULT_HOST = "127.0.0.1";

export interface ViewerOptions {
  /** Builds the data: once at start, and again after every burst of changes to watched files. */
  load: () => Promise<ViewData>;
  /**
   * Files and directories to watch (directories recursively). A function is re-evaluated after
   * every rebuild, so a new project or spec is picked up.
   */
  watch: readonly string[] | ((data: ViewData) => readonly string[]);
  /** 0 (the default) picks a free port. */
  port?: number;
  /** Default `127.0.0.1`. Must be a loopback address: the viewer never listens on the network. */
  host?: string;
  /** Quiet period before a rebuild (default 150 ms). */
  debounceMs?: number;
  /** Poll instead of `fs.watch`. */
  poll?: boolean;
  /** Called after every rebuild (not the first load). */
  onReload?: (event: ReloadEvent) => void;
}

export interface ReloadEvent {
  version: number;
  /** The rebuild failed; the previous data is still served, with `error` set. */
  error?: string;
  ms: number;
}

export interface Viewer {
  /** `http://<host>:<port>/` */
  url: string;
  host: string;
  port: number;
  /** The data currently served. */
  data(): ViewData;
  /** Rebuild now, as if a watched file had changed. Resolves after the reload is announced. */
  reload(): Promise<void>;
  /** Stops watching, ends event streams and closes the server. Idempotent. */
  close(): Promise<void>;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
} as const;

const HEARTBEAT_MS = 25_000;

/**
 * Serves the viewer on `host:port` (default `127.0.0.1`, a random free port):
 * - `GET /` the page, `GET /app.js` the app bundle, `GET /vendor/mermaid/…` Mermaid
 * - `GET /api/data` the current `ViewData` as JSON
 * - `GET /api/events` server-sent events: `reload` after watched files change and the data is rebuilt
 *
 * Loopback only: a non-loopback `host` is rejected. Requests whose `Host` is not a loopback name
 * get 403 (DNS rebinding, `host-guard.ts`); anything
 * but GET/HEAD gets 405. Rejects when the first `load()` throws or the port is taken.
 */
export async function startViewer(options: ViewerOptions): Promise<Viewer> {
  const host = options.host ?? DEFAULT_HOST;
  if (!isLoopback(host)) {
    throw new Error(`startViewer: ${host} is not a loopback address; the viewer is local-only`);
  }
  let data: ViewData = { ...(await options.load()), version: 1 };
  // Start the bundle build now so the first page load doesn't wait for all of it.
  appBundle().catch(() => {});

  const streams = new Set<ServerResponse>();
  let closed = false;

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", `internal error: ${e}`);
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!isAllowedHost(req.headers.host)) {
      send(res, 403, "text/plain; charset=utf-8", "forbidden: unexpected Host header\n");
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      send(res, 405, "text/plain; charset=utf-8", "method not allowed\n");
      return;
    }
    const path = new URL(req.url ?? "/", "http://viewer.invalid").pathname;
    if (path === "/" || path === "/index.html") {
      send(res, 200, "text/html; charset=utf-8", await pageHtml(), req);
    } else if (path === "/app.js") {
      send(res, 200, "text/javascript; charset=utf-8", (await appBundle()).code, req);
    } else if (path === "/api/data") {
      send(res, 200, "application/json; charset=utf-8", JSON.stringify(data), req);
    } else if (path === "/api/events") {
      openStream(res);
    } else if (path.startsWith(MERMAID_PREFIX)) {
      const asset = await mermaidAsset(path.slice(MERMAID_PREFIX.length));
      if (asset) send(res, 200, asset.type, asset.body, req);
      else send(res, 404, "text/plain; charset=utf-8", "not found\n");
    } else {
      send(res, 404, "text/plain; charset=utf-8", "not found\n");
    }
  }

  function openStream(res: ServerResponse): void {
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
    });
    res.write(`retry: 2000\n: version ${data.version}\n\n`);
    streams.add(res);
    res.on("close", () => streams.delete(res));
  }

  const watchList = (d: ViewData) =>
    [...(typeof options.watch === "function" ? options.watch(d) : options.watch)].sort();
  let watched: string[] = [];
  let watcher: Watcher | undefined;
  const rewatch = () => {
    const next = watchList(data);
    if (watcher && next.join("\n") === watched.join("\n")) return;
    watcher?.close();
    watched = next;
    watcher = watchPaths(watched, () => void reload(), {
      ...(options.debounceMs !== undefined && { debounceMs: options.debounceMs }),
      ...(options.poll !== undefined && { poll: options.poll }),
    });
  };

  // Rebuilds never overlap: a change during a rebuild schedules exactly one more.
  let running: Promise<void> | undefined;
  let again = false;
  function reload(): Promise<void> {
    if (closed) return Promise.resolve();
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      do {
        again = false;
        await rebuild();
      } while (again && !closed);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  async function rebuild(): Promise<void> {
    const start = performance.now();
    const version = data.version + 1;
    let error: string | undefined;
    try {
      const next = await options.load();
      data = { ...next, version };
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      const { error: _previous, ...last } = data;
      data = { ...last, version, error };
    }
    if (closed) return;
    rewatch();
    const message = `event: reload\ndata: ${JSON.stringify({ version })}\n\n`;
    for (const s of streams) s.write(message);
    options.onReload?.({
      version,
      ms: Math.round(performance.now() - start),
      ...(error && { error }),
    });
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const heartbeat = setInterval(() => {
    for (const s of streams) s.write(": ping\n\n");
  }, HEARTBEAT_MS);
  heartbeat.unref();
  rewatch();

  let closing: Promise<void> | undefined;
  return {
    url: `http://${urlHost(host)}:${port}/`,
    host,
    port,
    data: () => data,
    reload,
    close() {
      closing ??= (async () => {
        closed = true;
        clearInterval(heartbeat);
        watcher?.close();
        for (const s of streams) s.end();
        streams.clear();
        await new Promise<void>((done) => {
          server.close(() => done());
          server.closeAllConnections();
        });
        await running?.catch(() => {});
      })();
      return closing;
    },
  };
}

function send(
  res: ServerResponse,
  status: number,
  type: string,
  body: string | Buffer,
  req?: IncomingMessage,
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(req?.method === "HEAD" ? undefined : body);
}
