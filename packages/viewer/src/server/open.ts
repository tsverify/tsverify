import { spawn } from "node:child_process";

export interface OpenerCommand {
  command: string;
  args: string[];
}

/** The platform's "open this URL in the default browser" command. */
export function openerCommand(url: string, platform: NodeJS.Platform): OpenerCommand {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      // `start` is a cmd builtin; its first quoted argument is the window title.
      return { command: "cmd", args: ["/c", "start", '""', url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  /** Replaces `child_process.spawn` (tests). */
  spawn?: (command: string, args: string[]) => { on(event: "error", cb: (e: Error) => void): void };
  /** Called when the opener cannot be started (e.g. no `xdg-open`). */
  onError?: (error: Error) => void;
}

/** Opens `url` in the default browser, detached; never throws. Only for `tsv view --open`. */
export function openBrowser(url: string, options: OpenBrowserOptions = {}): void {
  const { command, args } = openerCommand(url, options.platform ?? process.platform);
  const run =
    options.spawn ??
    ((cmd: string, argv: string[]) => {
      const child = spawn(cmd, argv, { detached: true, stdio: "ignore" });
      child.unref();
      return child;
    });
  try {
    run(command, args).on("error", (e) => options.onError?.(e));
  } catch (e) {
    options.onError?.(e instanceof Error ? e : new Error(String(e)));
  }
}
