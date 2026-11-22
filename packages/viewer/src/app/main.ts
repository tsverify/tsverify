/// <reference lib="dom" />
/**
 * Browser entry, bundled by the server with esbuild: fetch `/api/data`, render, and re-fetch on
 * every `reload` event from `/api/events`.
 */
import { h, render } from "preact";
import type { ViewData } from "../view-data";
import { App, type Connection } from "./components/app";

const root = document.getElementById("app");
let data: ViewData | undefined;
let connection: Connection = "connecting";

function draw(): void {
  if (!root) return;
  if (!data) {
    root.textContent =
      connection === "offline" ? "Cannot reach the tsverify view server." : "Loading…";
    return;
  }
  render(h(App, { data, connection }), root);
}

async function refresh(): Promise<void> {
  const res = await fetch("/api/data", { cache: "no-store" });
  if (!res.ok) throw new Error(`GET /api/data: ${res.status}`);
  data = (await res.json()) as ViewData;
  draw();
}

function listen(): void {
  const events = new EventSource("/api/events");
  events.addEventListener("open", () => {
    connection = "live";
    // The server may have rebuilt while we were disconnected.
    refresh().catch(() => {});
  });
  events.addEventListener("reload", () => {
    refresh().catch(() => {});
  });
  events.addEventListener("error", () => {
    connection = "offline";
    draw();
  });
}

if (root) root.textContent = "";
refresh().then(listen, () => {
  connection = "offline";
  draw();
  listen();
});
