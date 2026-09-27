export interface DnsResolver {
  resolve(host: string): Promise<string[]>;
}
