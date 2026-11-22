import type { BehaviorModel } from "@tsverify/ir";
import { permissionMatrix, summarize } from "@tsverify/render";
import { type ComponentChild, h } from "preact";
import { type Inline, parseMarkdown } from "../markdown";

/** `summarize` (`@tsverify/render`) as elements. */
export function SummaryView({ model }: { model: BehaviorModel }): ComponentChild {
  return h(
    "div",
    { class: "summary" },
    parseMarkdown(summarize(model)).map((block) =>
      block.type === "p"
        ? h("p", null, inlines(block.inlines))
        : h(
            "ul",
            null,
            block.items.map((item) => h("li", null, inlines(item))),
          ),
    ),
  );
}

function inlines(items: Inline[]): ComponentChild[] {
  return items.map((i) =>
    i.type === "text"
      ? i.text
      : i.type === "strong"
        ? h("strong", null, i.text)
        : h("code", null, i.text),
  );
}

/**
 * `permissionMatrix` (`@tsverify/render`) as a table, with the same markers as its Markdown form:
 * ✓ and the guards, — for not allowed, ⚠ for untrusted rows and unguarded untrusted cells.
 */
export function MatrixTable({ model }: { model: BehaviorModel }): ComponentChild {
  const m = permissionMatrix(model);
  const untrusted = new Set(m.untrusted);
  return h(
    "div",
    { class: "table-scroll" },
    h(
      "table",
      { class: "matrix" },
      h("caption", { class: "visually-hidden" }, "Which actor can perform which transition"),
      h(
        "thead",
        null,
        h(
          "tr",
          null,
          h("th", { scope: "col" }, "Actor"),
          m.transitions.map((t) => h("th", { scope: "col" }, t)),
        ),
      ),
      h(
        "tbody",
        null,
        m.actors.map((actor) => {
          const isUntrusted = untrusted.has(actor);
          return h(
            "tr",
            null,
            h(
              "th",
              { scope: "row" },
              actor,
              isUntrusted ? h("span", { class: "warn" }, " ⚠ untrusted") : null,
            ),
            m.transitions.map((t) => {
              const cell = m.cells[actor]?.[t];
              if (!cell?.allowed) {
                return h(
                  "td",
                  { class: "denied" },
                  h("span", { "aria-label": "not allowed" }, "—"),
                );
              }
              if (cell.guards.length > 0)
                return h("td", { class: "allowed" }, `✓ ${cell.guards.join(", ")}`);
              if (!isUntrusted) return h("td", { class: "allowed" }, "✓");
              return h("td", { class: "unguarded" }, h("strong", null, "✓ ⚠ unguarded"));
            }),
          );
        }),
      ),
    ),
    h(
      "p",
      { class: "muted legend" },
      "✓ allowed, with the guards that must pass · — not allowed · ⚠ untrusted: its requests cannot be trusted",
    ),
  );
}
