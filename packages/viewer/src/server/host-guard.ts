/**
 * The viewer is for this machine only: it listens on loopback (`startViewer` refuses anything
 * else). To view it from another machine, forward the port over SSH (`docs/viewer.md`).
 *
 * DNS-rebinding guard. A page on another site can make the browser resolve its own host name to
 * 127.0.0.1 and then read our responses as same-origin; the request still carries that host name
 * in `Host`. So a request is served only when its `Host` is a loopback name or address
 * (`localhost`, `127.x.x.x`, `[::1]`). Any port is fine: rebinding needs an attacker-controlled
 * name, and an SSH tunnel (`ssh -L 9000:127.0.0.1:4400`) changes the port the browser sees.
 */
export function isAllowedHost(header: string | undefined): boolean {
  if (header === undefined) return false;
  const m = /^(\[[^\]]+\]|[^:]+)(?::\d{1,5})?$/.exec(header.trim().toLowerCase());
  return m !== null && isLoopback(m[1] as string);
}

/** `::1` → `[::1]`: an IPv6 literal is bracketed in URLs and `Host` headers. */
export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

/** true for addresses only this machine can reach. */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}
