import { hostname, type NetworkInterfaceInfo, networkInterfaces } from "node:os";
import { isLoopback, urlHost } from "./host-guard";

/**
 * The URLs to print for a server bound to `host:port`, like Next/Vite's "Local" and "Network":
 * - loopback (`127.0.0.1`, the default): `local` only; nothing else can reach it
 * - a wildcard (`0.0.0.0`, `::`): `local` on loopback, `network` on every external interface
 *   address (IPv4 for `0.0.0.0`; IPv4 and IPv6 for `::`, without link-local `fe80::`, which
 *   needs a zone id)
 * - one specific external address: `network` only
 */
export interface ViewerUrls {
  local?: string;
  network: string[];
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

const WILDCARD_V4 = "0.0.0.0";
const WILDCARD_V6 = new Set(["::", "[::]"]);

function url(host: string, port: number): string {
  return `http://${urlHost(host)}:${port}/`;
}

export function isWildcard(host: string): boolean {
  return host === WILDCARD_V4 || WILDCARD_V6.has(host);
}

/** External interface addresses a wildcard bind answers on, in interface order. */
export function externalAddresses(
  host: string,
  interfaces: Interfaces = networkInterfaces(),
): string[] {
  if (!isWildcard(host)) return isLoopback(host) ? [] : [host];
  const v6 = WILDCARD_V6.has(host);
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.internal) continue;
      if (a.family === "IPv4" || (v6 && !a.address.toLowerCase().startsWith("fe80:"))) {
        out.push(a.address);
      }
    }
  }
  return [...new Set(out)];
}

export function viewerUrls(
  host: string,
  port: number,
  interfaces: Interfaces = networkInterfaces(),
): ViewerUrls {
  if (isLoopback(host)) return { local: url(host, port), network: [] };
  const network = externalAddresses(host, interfaces).map((a) => url(a, port));
  if (!isWildcard(host)) return { network };
  return { local: url(WILDCARD_V6.has(host) ? "localhost" : "127.0.0.1", port), network };
}

/**
 * Host names a non-loopback bind also answers (for the `Host` guard): its external addresses
 * on the port, and this machine's name on any port. Empty for loopback binds.
 */
export function exposedHosts(
  host: string,
  port: number,
  interfaces: Interfaces = networkInterfaces(),
): { exact: string[]; names: string[] } {
  if (isLoopback(host)) return { exact: [], names: [] };
  return {
    exact: externalAddresses(host, interfaces).map((a) => `${urlHost(a)}:${port}`.toLowerCase()),
    names: isWildcard(host) ? [hostname().toLowerCase()] : [],
  };
}
