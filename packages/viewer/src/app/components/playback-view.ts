/// <reference lib="dom" />
import type { BehaviorModel, Finding, Trace, WorkerPhase } from "@tsverify/ir";
import { toMermaid } from "@tsverify/render";
import { type ComponentChild, h } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type EffectCounter, type Frame, type LaneCell, playthrough } from "../frames";
import { Playback, SPEEDS, type Speed } from "../playback";
import { Diagram } from "./diagram";

export interface PlaybackViewProps {
  finding: Finding & { trace: Trace };
  /** The model the trace came from (`trace.model`), for the diagram and effect limits. */
  model?: BehaviorModel;
  /** Start at this step instead of the first one (tests). */
  start?: number;
}

const PHASE_TEXT: Record<WorkerPhase, string> = {
  idle: "idle",
  checked: "checked",
  done: "done",
  rejected: "rejected",
};

/**
 * Counterexample playback: the diagram with the current status and acting transition
 * highlighted, a step slider with play/pause/speed, worker swimlanes and effect counters.
 * Keys (when focus is inside): ←/→ step, Space or K play/pause, Home/End first/last step.
 */
export function PlaybackView({ finding, model, start }: PlaybackViewProps): ComponentChild {
  const { trace } = finding;
  const view = useMemo(() => playthrough(trace, model, finding), [trace, model, finding]);
  const [playback] = useState(() => {
    const p = new Playback(trace.steps.length);
    if (start !== undefined) p.seek(start);
    return p;
  });
  const [, setRevision] = useState(0);
  const section = useRef<HTMLElement>(null);
  // Opening a trace moves focus here, so the keys work at once.
  useEffect(() => section.current?.focus(), []);
  const act = (fn: (p: Playback) => void) => {
    fn(playback);
    setRevision((n) => n + 1);
  };

  useEffect(() => {
    if (playback.status !== "playing") return;
    const timer = setInterval(() => act((p) => p.tick()), playback.interval);
    return () => clearInterval(timer);
  }, [playback.status, playback.speed]);

  const frame = view.frames[playback.cursor] as Frame;
  const total = view.frames.length;
  const source = model ? toMermaid(model, { highlight: frame.highlight }) : undefined;

  const onKeyDown = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const inSlider = target?.getAttribute("type") === "range";
    if (target?.tagName === "SELECT") return;
    if (e.key === " " || e.key === "k" || e.key === "K") {
      if (target?.tagName === "BUTTON" && e.key === " ") return; // the button handles it
      act((p) => p.toggle());
    } else if (inSlider || e.altKey || e.ctrlKey || e.metaKey) {
      return;
    } else if (e.key === "ArrowRight") {
      act((p) => p.step(1));
    } else if (e.key === "ArrowLeft") {
      act((p) => p.step(-1));
    } else if (e.key === "Home") {
      act((p) => p.reset());
    } else if (e.key === "End") {
      act((p) => p.seek(p.last));
    } else {
      return;
    }
    e.preventDefault();
  };

  return h(
    "section",
    {
      ref: section,
      class: "playback",
      tabIndex: -1,
      "aria-label": `Counterexample playback: ${trace.property}`,
      onKeyDown,
    },
    h("h3", null, `Counterexample (${trace.model} model): `, h("code", null, trace.property)),
    h(
      "p",
      { class: "muted keys" },
      "Keys: ← → step · Space or K play/pause · Home first step · End last step",
    ),
    h(
      "div",
      { class: "controls", role: "group", "aria-label": "Playback controls" },
      h(
        "button",
        { type: "button", onClick: () => act((p) => p.reset()), "aria-label": "First step" },
        "⏮",
      ),
      h(
        "button",
        { type: "button", onClick: () => act((p) => p.step(-1)), "aria-label": "Previous step" },
        "◀",
      ),
      h(
        "button",
        {
          type: "button",
          class: "primary",
          onClick: () => act((p) => p.toggle()),
          "aria-label": playback.status === "playing" ? "Pause" : "Play",
        },
        playback.status === "playing" ? "⏸ Pause" : "▶ Play",
      ),
      h(
        "button",
        { type: "button", onClick: () => act((p) => p.step(1)), "aria-label": "Next step" },
        "▶",
      ),
      h(
        "button",
        { type: "button", onClick: () => act((p) => p.seek(p.last)), "aria-label": "Last step" },
        "⏭",
      ),
      h(
        "label",
        { class: "speed" },
        "Speed ",
        h(
          "select",
          {
            value: String(playback.speed),
            onChange: (e: Event) =>
              act((p) => p.setSpeed(Number((e.currentTarget as HTMLSelectElement).value) as Speed)),
          },
          SPEEDS.map((s) => h("option", { value: String(s) }, `${s}×`)),
        ),
      ),
      h("span", { class: `status-pill ${playback.status}` }, playback.status),
    ),
    h(
      "label",
      { class: "slider" },
      h("span", { class: "visually-hidden" }, "Step"),
      h("input", {
        type: "range",
        min: 0,
        max: total - 1,
        step: 1,
        value: playback.cursor,
        "aria-valuetext": `Step ${frame.index} of ${total - 1}: ${frame.label}`,
        onInput: (e: Event) =>
          act((p) => p.seek(Number((e.currentTarget as HTMLInputElement).value))),
      }),
    ),
    h(
      "p",
      { class: "now", "aria-live": "polite" },
      h("strong", null, `Step ${frame.index} / ${total - 1}`),
      ` · ${frame.label} · status `,
      h("code", null, frame.status),
      frame.violation ? h("span", { class: "violation" }, ` ✗ ${frame.violation.property}`) : null,
    ),
    frame.violation
      ? h(
          "p",
          { class: "violation-detail", role: "note" },
          `Violated: ${frame.violation.description}`,
        )
      : null,
    h(
      "div",
      { class: "playback-grid" },
      source
        ? h(Diagram, {
            source,
            label: `State diagram at step ${frame.index}: ${frame.status} highlighted`,
          })
        : h("p", { class: "muted" }, "No model available for the diagram."),
      h(Counters, { effects: frame.effects }),
    ),
    h(Swimlanes, { view, cursor: playback.cursor, onSeek: (i) => act((p) => p.seek(i)) }),
    h(
      "ol",
      { class: "steps", start: 0 },
      view.frames.map((f) =>
        h(
          "li",
          {
            key: f.position,
            class: f.position === playback.cursor ? "current" : undefined,
            "aria-current": f.position === playback.cursor ? "step" : undefined,
          },
          h(
            "button",
            { type: "button", class: "link", onClick: () => act((p) => p.seek(f.position)) },
            f.text,
          ),
        ),
      ),
    ),
  );
}

function Counters({ effects }: { effects: EffectCounter[] }): ComponentChild {
  if (effects.length === 0) return h("p", { class: "muted" }, "No effects in this trace.");
  return h(
    "div",
    { class: "counters" },
    h("h4", null, "Effects"),
    h(
      "ul",
      null,
      effects.map((e) =>
        h(
          "li",
          {
            key: e.name,
            class: ["counter", e.over && "over", e.violated && "violated"]
              .filter(Boolean)
              .join(" "),
          },
          h("code", null, e.name),
          h(
            "span",
            { class: "count" },
            String(e.count),
            e.limit !== undefined ? h("span", { class: "muted" }, ` / ${e.limit}`) : null,
          ),
          e.delta > 0 ? h("span", { class: "delta" }, `+${e.delta}`) : null,
          e.violated ? h("span", { class: "violation" }, " ✗ violated") : null,
        ),
      ),
    ),
  );
}

function Swimlanes({
  view,
  cursor,
  onSeek,
}: {
  view: ReturnType<typeof playthrough>;
  cursor: number;
  onSeek: (position: number) => void;
}): ComponentChild {
  return h(
    "div",
    { class: "swimlanes" },
    h("h4", null, "Workers"),
    h(
      "div",
      { class: "table-scroll" },
      h(
        "table",
        null,
        h(
          "caption",
          { class: "visually-hidden" },
          "Worker swimlanes: phase and observed status per step",
        ),
        h(
          "thead",
          null,
          h(
            "tr",
            null,
            h("th", { scope: "col" }, "Worker"),
            view.frames.map((f) =>
              h(
                "th",
                {
                  scope: "col",
                  class: f.position === cursor ? "current" : undefined,
                },
                h(
                  "button",
                  {
                    type: "button",
                    class: "link",
                    onClick: () => onSeek(f.position),
                    "aria-label": `Go to step ${f.index}`,
                  },
                  String(f.index),
                ),
              ),
            ),
          ),
        ),
        h(
          "tbody",
          null,
          view.lanes.map((lane) =>
            h(
              "tr",
              { key: lane.worker },
              h(
                "th",
                { scope: "row" },
                lane.worker,
                lane.duplicate ? h("span", { class: "muted" }, " (duplicate)") : null,
              ),
              lane.cells.map((cell, i) => laneCell(cell, i === cursor)),
            ),
          ),
        ),
      ),
    ),
    view.idleWorkers.length > 0
      ? h("p", { class: "muted" }, `Never act in this trace: ${view.idleWorkers.join(", ")}`)
      : null,
  );
}

function laneCell(cell: LaneCell, current: boolean): ComponentChild {
  const classes = ["lane", cell.phase, current && "current", cell.acting && "acting"]
    .filter(Boolean)
    .join(" ");
  return h(
    "td",
    { class: classes },
    cell.acting
      ? h(
          "span",
          { class: "act" },
          `▶ ${cell.acting.kind}${cell.acting.outcome === "rejected" ? " ✗" : ""}`,
        )
      : null,
    h("span", { class: "phase" }, PHASE_TEXT[cell.phase]),
    cell.observed !== undefined ? h("span", { class: "observed" }, `saw ${cell.observed}`) : null,
  );
}
