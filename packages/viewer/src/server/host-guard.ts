/**
 * DNS-rebinding guard. A page on another site can make the browser resolve its own host name to
 * 127.0.0.1 and then read our responses as same-origin; the request still carries that host name
 * in `Host`. So a request is served only when its `Host` names:
 * - a loopback name or address (`localhost`, `127.x.x.x`, `[::1]`) on **any** port: rebinding
 *   needs an attacker-controlled name, and port-forwarding tunnels (`ssh -L 9000:127.0.0.1:N`)
 *   change the port the browser sees;
 * - the bound host on the bound port, and when bound beyond loopback, each external address it
 *   answers on (with the port) and this machine's name (any port), see `addresses.ts`;
 * - a name passed with `--allow-host` (any port), e.g. this machine's name when listening on
 *   `0.0.0.0`, or a forwarding proxy's host.
 */

export interface HostRules {
  /** `host:port` values, lower-cased. */
  exact: ReadonlySet<string>;
  /** Host names allowed on any port, lower-cased, IPv6 bracketed. */
  names: ReadonlySet<string>;
}

/** The rules for a server bound to `host:port`, plus `extra` host names. */
export function allowedHosts(
  host: string,
  port: number,
  extra: readonly string[] = [],
  exposed: { exact: readonly string[]; names: readonly string[] } = { exact: [], names: [] },
): HostRules {
  return {
    exact: new Set([`${urlHost(host)}:${port}`.toLowerCase(), ...exposed.exact]),
    names: new Set([...extra.map((h) => urlHost(h.trim()).toLowerCase()), ...exposed.names]),
  };
}

export function isAllowedHost(header: string | undefined, rules: HostRules): boolean {
  if (header === undefined) return false;
  const value = header.trim().toLowerCase();
  if (rules.exact.has(value)) return true;
  const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(value);
  if (!m) return false;
  const name = m[1] as string;
  return isLoopback(name) || rules.names.has(name);
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
