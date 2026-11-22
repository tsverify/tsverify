import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it } from "vitest";
import { exposedHosts, viewerUrls } from "../src/server/addresses";

function nic(address: string, family: "IPv4" | "IPv6", internal = false): NetworkInterfaceInfo {
  const base = { address, netmask: "", mac: "00:00:00:00:00:00", internal, cidr: null };
  return family === "IPv4" ? { ...base, family } : { ...base, family, scopeid: 0 };
}

const INTERFACES = {
  lo: [nic("127.0.0.1", "IPv4", true), nic("::1", "IPv6", true)],
  eth0: [nic("10.0.0.5", "IPv4"), nic("fe80::1", "IPv6"), nic("2001:db8::5", "IPv6")],
  wlan0: [nic("192.168.1.20", "IPv4")],
};

describe("viewerUrls", () => {
  it("loopback: local only", () => {
    expect(viewerUrls("127.0.0.1", 4400, INTERFACES)).toEqual({
      local: "http://127.0.0.1:4400/",
      network: [],
    });
  });

  it("0.0.0.0: local on loopback, network on every external IPv4 address", () => {
    expect(viewerUrls("0.0.0.0", 4400, INTERFACES)).toEqual({
      local: "http://127.0.0.1:4400/",
      network: ["http://10.0.0.5:4400/", "http://192.168.1.20:4400/"],
    });
  });

  it(":: also lists IPv6, without link-local addresses", () => {
    expect(viewerUrls("::", 4400, INTERFACES)).toEqual({
      local: "http://localhost:4400/",
      network: ["http://10.0.0.5:4400/", "http://[2001:db8::5]:4400/", "http://192.168.1.20:4400/"],
    });
  });

  it("one specific external address: network only", () => {
    expect(viewerUrls("10.0.0.5", 4400, INTERFACES)).toEqual({
      network: ["http://10.0.0.5:4400/"],
    });
  });
});

describe("exposedHosts", () => {
  it("adds nothing for loopback binds", () => {
    expect(exposedHosts("127.0.0.1", 4400, INTERFACES)).toEqual({ exact: [], names: [] });
  });

  it("adds the external addresses (with the port) and this machine's name for wildcard binds", () => {
    const exposed = exposedHosts("0.0.0.0", 4400, INTERFACES);
    expect(exposed.exact).toEqual(["10.0.0.5:4400", "192.168.1.20:4400"]);
    expect(exposed.names).toHaveLength(1);
  });
});
