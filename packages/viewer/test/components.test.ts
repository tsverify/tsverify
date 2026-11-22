import { h, type VNode } from "preact";
import renderToStringPretty from "preact-render-to-string/jsx";
import { describe, expect, it } from "vitest";
import { App } from "../src/app/components/app";
import { PlaybackView } from "../src/app/components/playback-view";
import { buildViewData } from "../src/view-data";
import { tracedFinding, variantInput } from "./fixtures";

// Server-rendered goldens of the app on real B3 pipeline output. Mermaid only runs in the
// browser, so diagrams render as their (highlighted) source here. The pretty printer indents
// text inside <pre>; the browser gets it verbatim.

function html<P>(vnode: VNode<P>): string {
  return `${renderToStringPretty(vnode as VNode, {}, { pretty: "  ", jsx: false })}\n`;
}

const input = variantInput("b3-refund-race");
const data = buildViewData({ cwd: "/work/b3", specOnly: false, specs: [input] });

describe("components (B3)", () => {
  it("renders the spec page with findings grouped by root cause", async () => {
    const out = html(h(App, { data, connection: "live" }));
    expect(out).toContain("↳ consequence: ");
    await expect(out).toMatchFileSnapshot("__golden__/b3-app.html");
  });

  it("renders the playback of the double refund at its violating step", async () => {
    const finding = tracedFinding(input, "effect-multiplicity");
    const out = html(
      h(PlaybackView, {
        finding,
        model: input.code,
        start: finding.trace.steps.length - 1,
      }),
    );
    expect(out).toContain("paid --> refunded: ▶ refund · admin");
    expect(out).toContain("class refunded highlight");
    await expect(out).toMatchFileSnapshot("__golden__/b3-playback-last.html");
  });

  it("renders the playback at the first read of the race", async () => {
    const finding = tracedFinding(input, "effect-multiplicity");
    const out = html(h(PlaybackView, { finding, model: input.code, start: 3 }));
    await expect(out).toMatchFileSnapshot("__golden__/b3-playback-step3.html");
  });

  it("selects a trace from the app", () => {
    const finding = tracedFinding(input, "effect-multiplicity");
    const out = html(
      h(App, {
        data,
        connection: "offline",
        initial: { file: input.file, playing: finding.id, start: 0 },
      }),
    );
    expect(out).toContain("Counterexample (code model)");
    expect(out).toContain("offline: reconnecting");
    expect(out).toContain('aria-pressed="true"');
  });
});
