export interface AlertSink {
  fire(key: string, severity: "warning" | "critical", details: unknown): Promise<void>;
  resolve(key: string): Promise<void>;
}
