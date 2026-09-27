export interface MetaPage {
  items: unknown[];
  nextCursor: string | null;
  usagePct: number | null;
}

export interface MetaTokenHealth {
  expiresAt: Date | null;
  scopes: string[];
  valid: boolean;
}

export interface MetaClient {
  searchHashtag(name: string): Promise<string>;
  media(edge: "top" | "recent", hashtagId: string, cursor: string | null): Promise<MetaPage>;
  debugToken(): Promise<MetaTokenHealth>;
}
