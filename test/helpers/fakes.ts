import type { Clock } from "../../src/ports/clock.js";
import type { Queue, QueueJob } from "../../src/ports/queue.js";
import type { BlobStorage } from "../../src/ports/blob-storage.js";
import type { MetaClient, MetaPage, MetaTokenHealth } from "../../src/ports/meta-client.js";
import type { HttpDownloader, DownloadResult } from "../../src/ports/http-downloader.js";
import type { DnsResolver } from "../../src/ports/dns-resolver.js";
import type { SecretProvider } from "../../src/ports/secret-provider.js";
import type { Metrics } from "../../src/ports/metrics.js";
import type { AlertSink } from "../../src/ports/alert-sink.js";

export class FakeClock implements Clock {
  private current: Date;
  private listeners: Array<() => void> = [];

  constructor(start: Date) {
    this.current = start;
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
    for (const listener of this.listeners) listener();
  }

  /** Internal: lets FakeQueue re-check delayed jobs when time advances. */
  onAdvance(fn: () => void): void {
    this.listeners.push(fn);
  }
}

interface InternalJob extends QueueJob {
  availableAt: number;
  crashBeforeVisible?: boolean;
}

/**
 * An in-memory Queue for tests. Honors delayMs via the injected Clock so
 * tests can control visibility deterministically without real waiting.
 * Supports a `crashAfterEnqueue` hook so scenario tests can simulate a
 * process dying between committing work and the message becoming visible.
 */
export class FakeQueue implements Queue {
  private jobs: InternalJob[] = [];
  private nextId = 1;
  private clock: Clock;
  public crashAfterEnqueue = false;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  async enqueue(kind: string, payload: unknown, opts?: { delayMs?: number }): Promise<void> {
    if (this.crashAfterEnqueue) {
      // Simulate a crash: the job never actually gets added to the queue,
      // as if the process died before the enqueue call took effect.
      return;
    }
    const availableAt = this.clock.now().getTime() + (opts?.delayMs ?? 0);
    this.jobs.push({ id: String(this.nextId++), kind, payload, availableAt });
  }

  async receive(kinds: string[], max: number): Promise<QueueJob[]> {
    const now = this.clock.now().getTime();
    const eligible = this.jobs.filter(
      (j) => kinds.includes(j.kind) && j.availableAt <= now
    );
    const taken = eligible.slice(0, max);
    // Remove taken jobs from the visible queue until acked/released.
    this.jobs = this.jobs.filter((j) => !taken.includes(j));
    this.inFlight.push(...taken);
    return taken.map(({ availableAt, ...job }) => job);
  }

  private inFlight: InternalJob[] = [];

  async ack(job: QueueJob): Promise<void> {
    this.inFlight = this.inFlight.filter((j) => j.id !== job.id);
  }

  async release(job: QueueJob, opts?: { delayMs?: number }): Promise<void> {
    const inFlightJob = this.inFlight.find((j) => j.id === job.id);
    this.inFlight = this.inFlight.filter((j) => j.id !== job.id);
    const availableAt = this.clock.now().getTime() + (opts?.delayMs ?? 0);
    this.jobs.push({
      id: job.id,
      kind: job.kind,
      payload: job.payload,
      availableAt,
    });
    void inFlightJob;
  }
}

export class FakeStorage implements BlobStorage {
  private store = new Map<string, Uint8Array>();

  async exists(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async put(key: string, body: AsyncIterable<Uint8Array>, _contentType: string): Promise<void> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    this.store.set(key, merged);
  }

  async getReadUrl(key: string): Promise<string> {
    return `/files/${key}`;
  }

  getBytes(key: string): Uint8Array | undefined {
    return this.store.get(key);
  }
}

export class ScriptedMetaClient implements MetaClient {
  private pagesByEdge: Map<string, MetaPage[]>;
  private hashtagId: string;
  private callIndex = new Map<string, number>();
  public searchHashtagCalls = 0;
  public requestedCursors: (string | null)[] = [];
  public tokenHealth: MetaTokenHealth = { expiresAt: null, scopes: [], valid: true };
  public onMedia?: (edge: string, cursor: string | null) => void | never;

  constructor(opts: { hashtagId?: string; pagesByEdge: Record<string, MetaPage[]> }) {
    this.hashtagId = opts.hashtagId ?? "17843";
    this.pagesByEdge = new Map(Object.entries(opts.pagesByEdge));
  }

  async searchHashtag(_name: string): Promise<string> {
    this.searchHashtagCalls++;
    return this.hashtagId;
  }

  async media(edge: "top" | "recent", _hashtagId: string, cursor: string | null): Promise<MetaPage> {
    this.requestedCursors.push(cursor);
    if (this.onMedia) this.onMedia(edge, cursor);
    const pages = this.pagesByEdge.get(edge) ?? [];
    const idx = this.callIndex.get(edge) ?? 0;
    const page = pages[idx];
    this.callIndex.set(edge, idx + 1);
    if (!page) {
      return { items: [], nextCursor: null, usagePct: null };
    }
    return page;
  }

  async debugToken(): Promise<MetaTokenHealth> {
    return this.tokenHealth;
  }
}

interface ScriptedResponse {
  status: number;
  headers?: Record<string, string>;
  bodyChunks?: Uint8Array[];
  redirectTo?: string;
  delayMs?: number;
  totalBytes?: number;
}

export class FakeDownloader implements HttpDownloader {
  private responses: Map<string, ScriptedResponse>;
  public requestedUrls: string[] = [];

  constructor(responses: Record<string, ScriptedResponse>) {
    this.responses = new Map(Object.entries(responses));
  }

  async get(url: string): Promise<DownloadResult> {
    this.requestedUrls.push(url);
    const resp = this.responses.get(url);
    if (!resp) {
      throw new Error(`FakeDownloader: no scripted response for ${url}`);
    }
    if (resp.status >= 400) {
      const err = new Error(`HTTP ${resp.status}`) as Error & { status?: number };
      err.status = resp.status;
      throw err;
    }
    const chunks = resp.bodyChunks ?? [];
    return {
      body: (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
      contentType: resp.headers?.["content-type"] ?? null,
    };
  }
}

export class FakeDns implements DnsResolver {
  private records: Map<string, string[]>;

  constructor(records: Record<string, string[]>) {
    this.records = new Map(Object.entries(records));
  }

  async resolve(host: string): Promise<string[]> {
    const ips = this.records.get(host);
    if (!ips) throw new Error(`FakeDns: no record for ${host}`);
    return ips;
  }
}

export function staticSecrets(map: Record<string, string>): SecretProvider {
  return {
    async get(name: string) {
      return map[name];
    },
  };
}

export class RecordingMetrics implements Metrics {
  public incs: Array<{ name: string; labels?: Record<string, string>; by: number }> = [];
  public gauges: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];
  public observations: Array<{ name: string; value: number; labels?: Record<string, string> }> = [];

  inc(name: string, labels?: Record<string, string>, by = 1): void {
    this.incs.push({ name, labels, by });
  }
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    this.gauges.push({ name, value, labels });
  }
  observe(name: string, value: number, labels?: Record<string, string>): void {
    this.observations.push({ name, value, labels });
  }

  countOf(name: string): number {
    return this.incs.filter((i) => i.name === name).reduce((n, i) => n + i.by, 0);
  }
}

export class RecordingAlertSink implements AlertSink {
  public fired: Array<{ key: string; severity: string; details: unknown }> = [];
  public resolved: string[] = [];

  async fire(key: string, severity: "warning" | "critical", details: unknown): Promise<void> {
    this.fired.push({ key, severity, details });
  }
  async resolve(key: string): Promise<void> {
    this.resolved.push(key);
  }
}
