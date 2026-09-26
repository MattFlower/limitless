import { isIP } from "node:net";

/** Parse an IPv4/IPv6 address into [family, 128-bit-or-32-bit value]. */
function toBigInt(address: string): [4 | 6, bigint] | null {
  const ip = address.startsWith("::ffff:") && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
  const family = isIP(ip);
  if (family === 4) {
    return [4, ip.split(".").reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n)];
  }
  if (family === 6) {
    const [head = "", tail = ""] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
    const groups = ip.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
    if (groups.length !== 8) return null;
    return [6, groups.reduce((acc, g) => (acc << 16n) + BigInt(Number.parseInt(g || "0", 16)), 0n)];
  }
  return null;
}

/** True when `address` falls inside `cidr` (IPv4 or IPv6, e.g. "140.82.112.0/20"). */
export function inCidr(address: string, cidr: string): boolean {
  const [net, bitsText] = cidr.split("/");
  const a = toBigInt(address);
  const n = net ? toBigInt(net) : null;
  if (!a || !n || a[0] !== n[0]) return false;
  const width = a[0] === 4 ? 32 : 128;
  const bits = bitsText === undefined ? width : Number(bitsText);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  const shift = BigInt(width - bits);
  return a[1] >> shift === n[1] >> shift;
}

export function inAnyCidr(address: string, cidrs: string[]): boolean {
  return cidrs.some((c) => inCidr(address, c));
}
