/**
 * Dashboard lifecycle — terminal takeover and refresh loop.
 *
 * Runs in a separate `nexusrouter dash` process. Router process is unaffected:
 * the only coupling is read-only file tail and an occasional GET /health.
 */

import { watch, type FSWatcher } from "node:fs";
import { resolveLogDir } from "../paths.js";
import { createTailer, tail, type ParsedUsageEntry, type TailerState } from "./tailer.js";
import { emptyAggregates, updateAggregates, WINDOW_MS, type DashboardAggregates } from "./aggregator.js";
import { formatRecentEntry, renderFrame, type RenderInput, type RouterStatus } from "./render.js";
import { VERSION } from "../version.js";

export type DashboardOptions = {
  logDir?: string;
  port?: number;
  refreshMs?: number;
  healthMs?: number;
  windowSize?: number;
  /** Internal/test hook: trigger cleanup after N milliseconds. */
  stopAfterMs?: number;
};

const MIN_WIDTH = 40;
const MAX_HEALTH_BACKOFF_MS = 30_000;

/** Exported for tests. Returns the next /health poll interval. */
export function nextHealthBackoff(
  currentMs: number,
  baseMs: number,
  success: boolean,
  maxMs: number = MAX_HEALTH_BACKOFF_MS,
): number {
  if (success) return baseMs;
  return Math.min(currentMs * 2, maxMs);
}

export type DashboardState = {
  tailer: TailerState;
  aggregates: DashboardAggregates;
  recent: ParsedUsageEntry[];
  router: RouterStatus;
  baselineMode: string;
};

const ESC = "\x1b[";
const ALT_SCREEN_ON = `${ESC}?1049h`;
const ALT_SCREEN_OFF = `${ESC}?1049l`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const CLEAR_LINE = `${ESC}K`;
const MOVE_HOME = `${ESC}H`;

function createState(logDir: string): DashboardState {
  return {
    tailer: createTailer(logDir),
    aggregates: emptyAggregates(),
    recent: [],
    router: { online: false, enabled: false, persist: false, degraded: false },
    baselineMode: "requested",
  };
}

async function pollHealth(port: number): Promise<Partial<RouterStatus> | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      accounting?: { enabled: boolean; persist: boolean; degraded: boolean };
    };
    if (!data.accounting) return { online: true };
    return {
      online: true,
      enabled: data.accounting.enabled,
      persist: data.accounting.persist,
      degraded: data.accounting.degraded,
    };
  } catch {
    return null;
  }
}

function render(input: RenderInput): string {
  const lines = renderFrame(input);
  return MOVE_HOME + lines.map((l) => l + CLEAR_LINE).join("\n");
}

function buildRenderInput(state: DashboardState, width: number, height: number): RenderInput {
  const recent = state.recent
    .slice(-Math.max(3, height - 12))
    .reverse()
    .map(formatRecentEntry);
  return {
    version: VERSION,
    width,
    height,
    aggregates: state.aggregates,
    recent,
    router: state.router,
    baselineMode: state.baselineMode,
  };
}

function restoreTerminal(): void {
  try {
    process.stdout.write(ALT_SCREEN_OFF + SHOW_CURSOR);
  } catch {
    // Best effort on exit.
  }
}

/** Run one snapshot and exit — used when stdout is not a TTY. */
export async function runSnapshot(options: DashboardOptions = {}): Promise<void> {
  const logDir = options.logDir || resolveLogDir();
  const state = createState(logDir);
  const event = await tail(state.tailer);
  const now = Date.now();
  state.aggregates = updateAggregates(state.aggregates, event.entries, now);
  state.recent.push(...event.entries);

  const port = options.port || parseInt(process.env.NEXUSROUTER_PORT || "8402", 10);
  const health = await pollHealth(port);
  if (health) state.router = { ...state.router, ...health };

  const width = Math.max(MIN_WIDTH, process.stdout.columns || 120);
  const height = process.stdout.rows || 24;
  const input = buildRenderInput(state, width, height);
  console.log(renderFrame(input).join("\n"));
}

/** Run the live dashboard in the alternate screen buffer. */
export async function runDashboard(options: DashboardOptions = {}): Promise<void> {
  if (!process.stdout.isTTY) {
    return runSnapshot(options);
  }

  const logDir = options.logDir || resolveLogDir();
  const state = createState(logDir);
  const port = options.port || parseInt(process.env.NEXUSROUTER_PORT || "8402", 10);
  const refreshMs = options.refreshMs ?? 1000;
  const healthMs = options.healthMs ?? 2000;

  // Enter alternate screen and hide cursor.
  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR);

  let running = true;
  let width = Math.max(MIN_WIDTH, process.stdout.columns || 120);
  let height = process.stdout.rows || 24;

  let stopResolver: (() => void) | null = null;
  const stopped = new Promise<void>((resolve) => {
    stopResolver = resolve;
  });

  const cleanup = (signal?: string) => {
    if (!running) return;
    running = false;
    stopResolver?.();
    restoreTerminal();
    if (signal) process.exit(0);
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("exit", restoreTerminal);
  process.on("uncaughtException", (err) => {
    console.error(err);
    cleanup();
    process.exit(1);
  });
  process.stdout.on("resize", () => {
    width = Math.max(MIN_WIDTH, process.stdout.columns || width);
    height = process.stdout.rows || height;
  });

  // fs.watch triggers on most writes; poll covers Windows network drives and
  // atomic renames.
  let watcher: FSWatcher | null = null;
  try {
    watcher = watch(logDir, () => {
      void refresh();
    });
  } catch {
    // Fall back to polling only.
  }

  let lastHealth = 0;
  let healthBackoffMs = healthMs;

  const refresh = async () => {
    if (!running) return;
    try {
      const event = await tail(state.tailer);
      const now = Date.now();
      state.aggregates = updateAggregates(state.aggregates, event.entries, now);
      if (event.entries.length > 0) {
        state.recent.push(...event.entries);
        if (state.recent.length > 200) state.recent = state.recent.slice(-200);
      }

      if (now - lastHealth >= healthBackoffMs) {
        const health = await pollHealth(port);
        lastHealth = now;
        if (health) {
          state.router = { ...state.router, ...health };
          healthBackoffMs = nextHealthBackoff(healthBackoffMs, healthMs, true);
        } else {
          state.router.online = false;
          healthBackoffMs = nextHealthBackoff(healthBackoffMs, healthMs, false);
        }
      }

      const input = buildRenderInput(state, width, height);
      process.stdout.write(render(input));
    } catch (err) {
      // Never break the dashboard loop; worst case the next frame recovers.
      if (err instanceof Error) {
        process.stdout.write(MOVE_HOME + `Dashboard error: ${err.message}`.slice(0, width) + CLEAR_LINE);
      }
    }
  };

  await refresh();
  const timer = setInterval(() => void refresh(), refreshMs);
  timer.unref();

  if (options.stopAfterMs && options.stopAfterMs > 0) {
    const stopTimer = setTimeout(() => cleanup(), options.stopAfterMs);
    stopTimer.unref();
  }

  // Keep alive until cleanup — no busy-wait polling.
  await stopped;

  watcher?.close();
  clearInterval(timer);
}
