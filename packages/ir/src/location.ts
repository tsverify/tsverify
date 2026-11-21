/** A position in a source file. Lines and columns are 1-based. */
export interface SourceLocation {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
}
