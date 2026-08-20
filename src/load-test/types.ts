/**
 * Load-test types — shared between the runner and the CLI reporter.
 */

export type LoadTestOptions = {
  /** Test duration in milliseconds. */
  durationMs: number;
  /** Number of concurrent workers (connections). */
  connections: number;
  /** Port for NexusRouter; 0 means random. */
  routerPort: number;
  /** Enable accounting persistence to measure its overhead. */
  accounting: boolean;
  /** Optional log directory override. */
  logDir?: string;
};

export type RequestSample = {
  /** Total latency in ms (end-to-end, including body read). */
  latencyMs: number;
  /** HTTP status code; 0 means network/timeout error. */
  status: number;
  /** True for 2xx responses. */
  ok: boolean;
};

export type LoadTestResult = {
  /** Options used for this run. */
  options: LoadTestOptions;
  /** Total completed requests. */
  total: number;
  /** Successful 2xx responses. */
  successes: number;
  /** Failed or non-2xx responses. */
  errors: number;
  /** Requests per second. */
  throughput: number;
  /** Test wall-clock duration in ms. */
  durationMs: number;
  /** p50 / p95 / p99 latency in ms. */
  p50: number | null;
  p95: number | null;
  p99: number | null;
  /** Minimum and maximum observed latency in ms. */
  minLatency: number | null;
  maxLatency: number | null;
  /** RSS memory at start and end in bytes. */
  memoryStart: NodeJS.MemoryUsage;
  memoryEnd: NodeJS.MemoryUsage;
  /** Raw samples, kept for downstream analysis. */
  samples: RequestSample[];
};
