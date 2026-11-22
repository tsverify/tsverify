import { type ComponentChild, h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { renderMermaid } from "./mermaid-loader";

export interface DiagramProps {
  /** Mermaid source. */
  source: string;
  /** Accessible name of the diagram. */
  label: string;
}

/**
 * A Mermaid diagram. Until Mermaid has rendered (and on the server, in tests) it shows the
 * source text, which is readable on its own. Re-renders when `source` changes, keeping the
 * previous drawing meanwhile; a slower stale render never overwrites a newer one.
 */
export function Diagram({ source, label }: DiagramProps): ComponentChild {
  const [svg, setSvg] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const ticket = ++latest.current;
    renderMermaid(source).then(
      (out) => {
        if (ticket !== latest.current) return;
        setSvg(out);
        setFailed(false);
      },
      () => {
        if (ticket === latest.current) setFailed(true);
      },
    );
  }, [source]);

  if (svg !== undefined && !failed) {
    // Mermaid sanitizes its SVG (securityLevel: strict).
    return h("figure", {
      class: "diagram",
      role: "img",
      "aria-label": label,
      dangerouslySetInnerHTML: { __html: svg },
    });
  }
  return h(
    "figure",
    { class: "diagram", "aria-label": label },
    failed
      ? h("p", { class: "muted" }, "Mermaid could not render this diagram. Its source:")
      : null,
    h("pre", { class: "diagram-source" }, source),
  );
}
