import { type ComponentChild, h } from "preact";
import { useState } from "preact/hooks";
import type { ViewData } from "../../view-data";
import { severityCounts } from "../findings-tree";
import { SpecPanel } from "./spec-panel";

/** Live-reload connection state, shown in the header. */
export type Connection = "connecting" | "live" | "offline";

export interface AppProps {
  data: ViewData;
  connection: Connection;
  /** Initial selection (tests): a spec file and a finding id whose trace to play. */
  initial?: { file?: string; playing?: string; start?: number };
}

/** The whole page: header, spec list, and the selected spec. */
export function App({ data, connection, initial }: AppProps): ComponentChild {
  const [file, setFile] = useState(initial?.file);
  const [playing, setPlaying] = useState<Record<string, string>>(
    initial?.file && initial.playing ? { [initial.file]: initial.playing } : {},
  );
  const selected = data.specs.find((s) => s.file === file) ?? data.specs[0];

  return h(
    "div",
    { class: "layout" },
    h(
      "header",
      { class: "top" },
      h("h1", null, "tsverify view"),
      h("span", { class: "muted cwd" }, data.cwd),
      data.specOnly ? h("span", { class: "badge" }, "spec only") : null,
      h(
        "span",
        { class: `connection ${connection}`, role: "status" },
        connection === "live"
          ? `● live · build ${data.version}`
          : connection === "connecting"
            ? "○ connecting…"
            : "○ offline: reconnecting…",
      ),
    ),
    data.error
      ? h(
          "p",
          { class: "banner error", role: "alert" },
          `The last rebuild failed; showing the previous build. ${data.error}`,
        )
      : null,
    data.specs.length > 1
      ? h(
          "nav",
          { class: "specs", "aria-label": "Behavior files" },
          h(
            "ul",
            null,
            data.specs.map((s) => {
              const counts = severityCounts(s.findings);
              const current = s === selected;
              return h(
                "li",
                { key: s.file },
                h(
                  "button",
                  {
                    type: "button",
                    class: current ? "current" : undefined,
                    "aria-current": current ? "page" : undefined,
                    onClick: () => setFile(s.file),
                  },
                  h("span", { class: "spec-name" }, s.behavior ?? s.file),
                  h(
                    "span",
                    { class: "counts" },
                    counts.error > 0
                      ? h("span", { class: "severity error" }, `✗ ${counts.error}`)
                      : null,
                    counts.warning > 0
                      ? h("span", { class: "severity warning" }, `⚠ ${counts.warning}`)
                      : null,
                    counts.error + counts.warning === 0 ? h("span", { class: "ok" }, "✓") : null,
                  ),
                ),
              );
            }),
          ),
        )
      : null,
    h(
      "main",
      null,
      selected
        ? h(SpecPanel, {
            key: selected.file,
            spec: selected,
            playing: playing[selected.file],
            onPlay: (f) => setPlaying((p) => ({ ...p, [selected.file]: f.id })),
            start: selected.file === initial?.file ? initial.start : undefined,
          })
        : h("p", null, "No behavior files."),
    ),
  );
}
