import { promises as dns } from "node:dns";
import type { DnsResolver } from "../../ports/dns-resolver.js";

export class SystemDns implements DnsResolver {
  async resolve(host: string): Promise<string[]> {
    const results = await dns.lookup(host, { all: true });
    return results.map((r) => r.address);
  }
}
