/// <reference lib="dom" />
/**
 * Loads Mermaid from the viewer server (`/vendor/mermaid/…`, served from `node_modules`), once,
 * and renders diagram sources to SVG. Never touches the network beyond the viewer itself.
 */

/** The part of Mermaid's API the viewer uses. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

const MERMAID_URL = "/vendor/mermaid/mermaid.esm.min.mjs";

let api: Promise<MermaidApi> | undefined;
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  api ??= (import(/* webpackIgnore: true */ MERMAID_URL) as Promise<{ default: MermaidApi }>).then(
    (mod) => {
      const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: dark ? "dark" : "default",
      });
      return mod.default;
    },
  );
  return api;
}

/** `source` as an SVG string. */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  counter += 1;
  const { svg } = await mermaid.render(`tsv-diagram-${counter}`, source);
  return svg;
}
