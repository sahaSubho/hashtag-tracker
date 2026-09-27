import { isIP } from "node:net";

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inV4Range(ip: string, base: string, maskBits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const baseInt = ipv4ToInt(base);
  const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
  return (ipInt & mask) === (baseInt & mask);
}

const V4_PRIVATE_RANGES: Array<[string, number]> = [
  ["10.0.0.0", 8], // RFC1918
  ["172.16.0.0", 12], // RFC1918
  ["192.168.0.0", 16], // RFC1918
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. EC2/ECS metadata (169.254.169.254, 169.254.170.2)
  ["100.64.0.0", 10], // CGNAT (RFC6598)
  ["0.0.0.0", 8], // "this network"
  ["192.0.0.0", 24], // IETF protocol assignments
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
];

function isPrivateV4(ip: string): boolean {
  return V4_PRIVATE_RANGES.some(([base, bits]) => inV4Range(ip, base, bits));
}

function isPrivateV6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1") return true; // loopback
  if (normalized === "::") return true; // unspecified
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // ULA fc00::/7
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
      normalized.startsWith("fea") || normalized.startsWith("feb")) return true; // link-local fe80::/10
  // IPv4-mapped v6 addresses (::ffff:a.b.c.d) inherit the v4 rules.
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  return false;
}

/** True if `ip` is a loopback, private, link-local, CGNAT, or otherwise non-public address. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateV4(ip);
  if (version === 6) return isPrivateV6(ip);
  return true; // not a recognizable IP at all — refuse rather than guess
}

/** Wildcard host match, e.g. "*.cdninstagram.com" matches "scontent.cdninstagram.com". */
export function hostAllowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".cdninstagram.com"
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}
