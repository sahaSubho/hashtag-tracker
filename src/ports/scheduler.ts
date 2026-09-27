export interface Scheduler {
  start(): void;
  stop(): Promise<void>;
}
