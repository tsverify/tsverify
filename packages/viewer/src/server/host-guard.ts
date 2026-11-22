/**
 * DNS-rebinding guard. A page on another site can make the browser resolve its own host name to
 * 127.0.0.1 and then read our responses as same-origin; the request still carries that host name
 * in `Host`. So only requests addressed to the bound `host:port` or `localhost:port` are served.
 */

/** The `Host` header values the server answers, lower-cased. */
export function allowedHosts(host: string, port: number): Set<string> {
  return new Set([`${urlHost(host)}:${port}`.toLowerCase(), `localhost:${port}`]);
}

export function isAllowedHost(header: string | undefined, allowed: ReadonlySet<string>): boolean {
  return header !== undefined && allowed.has(header.trim().toLowerCase());
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
