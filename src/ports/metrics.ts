export interface Metrics {
  inc(name: string, labels?: Record<string, string>, by?: number): void;
  gauge(name: string, value: number, labels?: Record<string, string>): void;
  observe(name: string, value: number, labels?: Record<string, string>): void;
}
