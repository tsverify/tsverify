export type { DiffEntry, DiffRenderOptions, DiffTextOptions } from "./diff";
export {
  DIFF_COMMENT_MARKER,
  diffSummary,
  renderDiffMarkdown,
  renderDiffText,
} from "./diff";
export { DIFF_MARKERS, toMermaidDiff } from "./diff-mermaid";
export type { FormatFindingsOptions, Formatter } from "./findings";
export { formatFindings, plainFormatter } from "./findings";
export type { PermissionCell, PermissionMatrix } from "./matrix";
export { permissionMatrix, permissionMatrixMarkdown } from "./matrix";
export type { Highlight, MermaidOptions } from "./mermaid";
export { toMermaid } from "./mermaid";
export { summarize } from "./summary";
export type { SequenceDiagramOptions } from "./trace";
export { traceToSequenceDiagram, traceToText } from "./trace";
