/**
 * Everything the CLI touches in its host process, injected so every command runs in-process in
 * tests. Only the bin entry (`index.ts`) builds the real one.
 */
export interface Io {
  stdout(s: string): void;
  stderr(s: string): void;
  /** Absolute directory that relative paths resolve against and locations are reported from. */
  cwd: string;
  /** Whether stdout is a terminal (enables colors unless `NO_COLOR` is set). */
  isTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Long-running commands (`tsverify view`) stop when the user asks: `listener` runs on the first
   * interrupt (Ctrl+C / SIGINT, or SIGTERM). Returns a function that removes the listener. The bin
   * installs the signal handlers only while a listener is registered, so other commands keep the
   * default Ctrl+C behavior. Absent: the command runs until the process exits.
   */
  onInterrupt?(listener: () => void): () => void;
}
