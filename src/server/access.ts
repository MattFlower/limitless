import { BlockList, isIP } from "node:net";

function addresses(values: string[]) {
  const list = new BlockList();
  for (const value of values) if (isIP(value)) list.addAddress(value, isIP(value) === 6 ? "ipv6" : "ipv4");
  return list;
}
const local = addresses(["::1"]);
local.addSubnet("127.0.0.0", 8, "ipv4");
const nonUnicast = addresses(["::", "::1"]);
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["127.0.0.0", 8],
  ["224.0.0.0", 3],
] as const)
  nonUnicast.addSubnet(ip, prefix, "ipv4");
nonUnicast.addSubnet("ff00::", 8, "ipv6");
const contains = (list: BlockList, ip: string) =>
  Boolean(isIP(ip)) && !ip.includes("%") && list.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
export const isLoopback = (ip: string) => contains(local, ip);
export const isLanAddress = (ip: string) =>
  Boolean(isIP(ip)) && !ip.includes("%") && !contains(nonUnicast, ip);

export function classifyRequest(peer: string | null, headers: Headers, proxies: string[]) {
  if (headers.has("cf-connecting-ip")) return "tunnel";
  if (!peer || !isIP(peer) || peer.includes("%")) return "denied";
  if (isLoopback(peer) && ![...headers.keys()].some((key) => key.toLowerCase().startsWith("x-forwarded-")))
    return "loopback";
  return contains(addresses(proxies), peer) ? "proxy" : "denied";
}

export function publicOrigin(value: unknown): string {
  if (typeof value === "string" && /^https?:\/\/[^/?#\\\s@]+\/?$/i.test(value)) {
    try {
      return new URL(value).origin;
    } catch {
      /* report the config key below */
    }
  }
  throw new Error(
    "server.public_origins must contain HTTP(S) origins without credentials, paths, query or fragment",
  );
}

export function publicHost(host: string | null, origins: string[]): boolean {
  if (!host || !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])(?::[0-9]+)?$/i.test(host)) return false;
  return origins.some((origin) => {
    try {
      const url = new URL(origin);
      return new URL(`${url.protocol}//${host}`).host === url.host;
    } catch {
      return false;
    }
  });
}
