/// <reference lib="dom" />
/**
 * Loads Mermaid, once, and renders diagram sources to SVG. Never touches the network beyond the
 * viewer itself. In development the import below is left external and the server answers it
 * from `node_modules`; the published CLI bundles the part of Mermaid the viewer uses into
 * lazily loaded chunks instead (`server/app-build.ts`). So the specifier must stay a string
 * literal, which esbuild follows (`as string` only keeps TypeScript from resolving the URL).
 */

/** The part of Mermaid's API the viewer uses. */
interface MermaidApi {
  initialize(config: Record<string, unknown>): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let api: Promise<MermaidApi> | undefined;
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  api ??= (
    import("/vendor/mermaid/mermaid.esm.min.mjs" as string) as Promise<{ default: MermaidApi }>
  ).then((mod) => {
    const dark = globalThis.matchMedia?.("(prefers-color-scheme: dark)").matches === true;
    mod.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: dark ? "dark" : "default",
    });
    return mod.default;
  });
  return api;
}

/** `source` as an SVG string. */
export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await loadMermaid();
  counter += 1;
  const { svg } = await mermaid.render(`tsverify-diagram-${counter}`, source);
  return svg;
}
