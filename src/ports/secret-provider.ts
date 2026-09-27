export interface SecretProvider {
  get(name: string): Promise<string | undefined>;
}
