#!/usr/bin/env node
/**
 * NexusRouter CLI
 *
 * Smart LLM Router - direct model API calls without payment layer.
 *
 * Usage:
 *   nexusrouter                  # Start server
 *   nexusrouter --version        # Show version
 *   nexusrouter --port 8402      # Custom port
 *   nexusrouter doctor [question] # Run diagnostics
 *   nexusrouter eval <labeled.jsonl> # Evaluate routing quality against labels
 *
 * For production deployments, use with PM2:
 *   pm2 start "npx nexusrouter" --name nexusrouter
 */

import { startServer } from "./server.js";
import { VERSION } from "./version.js";
import { getDefaultConfigPath, ensureConfigExists, loadConfig, type Config } from "./config/loader.js";
import { flushLogs, flushLogsSync } from "./logger.js";
import { getStats, formatStatsAscii } from "./stats.js";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { evaluateFile, formatEvalReport } from "./eval.js";

type KeyMode = "fixed" | "passthrough" | "none";

/**
 * Classify how API keys are supplied for the default-config first-launch message.
 * - "passthrough": at least one provider forwards the client's own key.
 * - "fixed": at least one provider has a non-empty server-side key.
 * - "none": no provider is configured to authenticate upstream requests.
 */
export function classifyKeyMode(config: Config): KeyMode {
  const providers = Object.values(config.providers || {});
  if (providers.some((p) => p.passthroughApiKey)) return "passthrough";
  if (providers.some((p) => p.apiKey && p.apiKey.trim().length > 0)) return "fixed";
  return "none";
}

/** Human-readable default config path, tuned per OS for the help text. */
function defaultConfigHint(): string {
  return process.platform === "win32"
    ? "%USERPROFILE%\\.nexus-router\\config.yaml"
    : "~/.nexus-router/config.yaml";
}

export function printHelp(): void {
  console.log(`
NexusRouter v${VERSION} - Smart LLM Router (Direct API, No Payments)

Usage:
  nexusrouter [options]
  nexusrouter doctor [question]
  nexusrouter eval <labeled.jsonl>
  nexusrouter stats [days]
  nexusrouter report [days]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: 8402)
  --config <path>   Path to config file
                    (default: ${defaultConfigHint()})
                    resolved to: ${getDefaultConfigPath()}
                    Created automatically on first launch if missing.
  --json            Output stats/report as JSON instead of ASCII/text

Commands:
  doctor            AI-powered diagnostics
  stats [days]      Show usage statistics (default: 7 days)
  report [days]     Show detailed usage report (default: 7 days)
  eval              Evaluate routing quality against a labeled routing log
                    (JSONL lines annotated with expectedTier; sibling
                    routing-outcome-*.jsonl files are joined automatically)

Examples:
  # Start server
  npx nexusrouter

  # Run diagnostics
  npx nexusrouter doctor "why is my request failing?"

  # Today's usage stats
  npx nexusrouter stats 1

  # Detailed JSON report for the last 7 days
  npx nexusrouter report --json

  # Evaluate routing accuracy against human labels
  npx nexusrouter eval ~/.nexus-router/logs/labeled.jsonl

Environment Variables:
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key
  GOOGLE_API_KEY      Google API key
  NEXUSROUTER_PORT    Default server port (default: 8402)

For more info: https://github.com/neochen2286-rgb/NexusRouter
`);
}

type ParsedArgs = {
  version: boolean;
  help: boolean;
  doctor: boolean;
  doctorQuestion?: string;
  stats: boolean;
  report: boolean;
  json: boolean;
  days?: number;
  eval: boolean;
  evalFile?: string;
  port?: number;
  config?: string;
};

export function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = {
    version: false,
    help: false,
    doctor: false,
    doctorQuestion: undefined,
    stats: false,
    report: false,
    json: false,
    days: undefined,
    eval: false,
    evalFile: undefined,
    port: undefined,
    config: undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "doctor" || arg === "--doctor") {
      result.doctor = true;
      result.doctorQuestion =
        args
          .slice(i + 1)
          .join(" ")
          .trim() || undefined;
      break;
    } else if (arg === "eval" || arg === "--eval") {
      result.eval = true;
      // The next arg is the labeled JSONL path (quote paths with spaces).
      result.evalFile = args[i + 1];
      break;
    } else if (arg === "stats") {
      result.stats = true;
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        result.days = parseInt(next, 10);
        i++;
      }
    } else if (arg === "report") {
      result.report = true;
      const next = args[i + 1];
      if (next && /^\d+$/.test(next)) {
        result.days = parseInt(next, 10);
        i++;
      }
    } else if (arg === "--port" && args[i + 1]) {
      result.port = parseInt(args[i + 1], 10);
      i++;
    } else if (arg === "--config" && args[i + 1]) {
      result.config = args[i + 1];
      i++;
    }
  }

  return result;
}

/** Ask /health whether accounting is currently degraded. */
async function queryDegradedState(
  port: number,
): Promise<{ degraded: boolean; reason: string | null } | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      accounting?: { degraded: boolean; degradedReason: string | null };
    };
    if (!data.accounting) return null;
    return {
      degraded: data.accounting.degraded,
      reason: data.accounting.degradedReason,
    };
  } catch {
    return null;
  }
}

async function runStats(args: ParsedArgs): Promise<void> {
  const days = args.days ?? 7;
  const stats = await getStats(days);
  if (args.json) {
    console.log(JSON.stringify(stats, null, 2));
  } else {
    console.log(formatStatsAscii(stats));
  }
}

async function runReport(args: ParsedArgs): Promise<void> {
  const days = args.days ?? 7;
  const stats = await getStats(days);
  const port = args.port || parseInt(process.env.NEXUSROUTER_PORT || "8402", 10);
  const degraded = await queryDegradedState(port);

  const report = {
    ...stats,
    generatedAt: new Date().toISOString(),
    degradedNow: degraded?.degraded ?? null,
    degradedReason: degraded?.reason ?? null,
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push("═".repeat(62));
  lines.push(` NexusRouter Usage Report — ${stats.period}`.padEnd(62) + "═");
  lines.push("═".repeat(62));
  lines.push(`  Total requests:        ${stats.totalRequests}`);
  lines.push(`  Upstream usage:        ${stats.upstreamRequests}`);
  lines.push(`  Estimated usage:       ${stats.estimatedRequests}`);
  if (stats.truncatedRequests > 0) {
    lines.push(`  Truncated streams:     ${stats.truncatedRequests}`);
  }
  lines.push(`  Entries with baseline: ${stats.entriesWithBaseline}`);
  lines.push(`  Total cost:            ¥${stats.totalCost.toFixed(4)}`);
  lines.push(`  Baseline cost:         ¥${stats.totalBaselineCost.toFixed(4)}`);
  lines.push(
    `  Total saved:           ¥${stats.totalSavings.toFixed(4)} (${stats.savingsPercentage.toFixed(1)}%)`,
  );
  lines.push(`  Avg latency:           ${stats.avgLatencyMs.toFixed(0)} ms`);
  if (report.degradedNow === true) {
    lines.push(`  ⚠️  Accounting degraded: ${report.degradedReason || "unknown reason"}`);
  } else if (report.degradedNow === false) {
    lines.push(`  ✅ Accounting healthy`);
  } else {
    lines.push(`  ⚪ Degraded state unknown (server not running on port ${port})`);
  }
  console.log(lines.join("\n"));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (args.doctor) {
    console.log("Doctor command not yet implemented for NexusRouter");
    process.exit(0);
  }

  if (args.stats) {
    await runStats(args);
    process.exit(0);
  }

  if (args.report) {
    await runReport(args);
    process.exit(0);
  }

  if (args.eval) {
    if (!args.evalFile) {
      console.error("[NexusRouter] Usage: nexusrouter eval <labeled.jsonl>");
      process.exit(1);
    }
    try {
      const report = await evaluateFile(args.evalFile);
      console.log(formatEvalReport(report));
      console.log("\nJSON summary:");
      console.log(JSON.stringify(report, null, 2));
      process.exit(0);
    } catch (error) {
      console.error(
        `[NexusRouter] eval failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(1);
    }
  }

  // Start the server. Left undefined when neither --port nor NEXUSROUTER_PORT
  // is set, so config.router.port applies.
  const port = resolveListenPort(args.port, process.env.NEXUSROUTER_PORT);

  // Resolve config path: explicit --config wins; otherwise the home-dir
  // default, which is auto-created from the template on first launch.
  const configPath = args.config ?? getDefaultConfigPath();
  if (!args.config) {
    const { created } = await ensureConfigExists(configPath);
    if (created) {
      const config = await loadConfig(configPath);
      const mode = classifyKeyMode(config);
      if (mode === "passthrough") {
        console.log(
          `✅ 已创建默认配置：${configPath}\n` +
            `当前为「客户端 API Key 透传」模式，服务端不强制配置固定 key。\n` +
            `客户端（Claude Code / Codex / OpenAI SDK 等）需在请求头中自带 ` +
            `Authorization: Bearer <key>。`,
        );
      } else if (mode === "fixed") {
        console.log(
          `✅ 已创建默认配置：${configPath}\n` +
            `已检测到服务端固定 API Key，继续启动...`,
        );
      } else {
        console.warn(
          `⚠️ 已创建默认配置：${configPath}\n` +
            `当前既未配置服务端 API Key，也未启用客户端透传。\n` +
            `LLM 上游请求将返回 401，请编辑配置或设置环境变量后重启。`,
        );
      }
    }
  }

  // The port is only known here when the CLI layer supplied one; otherwise
  // config.router.port decides and startServer logs the address it bound.
  console.log(
    port === undefined
      ? "[NexusRouter] Starting server..."
      : `[NexusRouter] Starting server on port ${port}...`,
  );

  try {
    await startServer(configPath, port);
    console.log(`[NexusRouter] Ready - Ctrl+C to stop`);
  } catch (error) {
    console.error(
      `[NexusRouter] Failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // Handle graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[NexusRouter] Received ${signal}, shutting down...`);
    // Drain queued log lines before exiting — batching means up to 200 ms of
    // routing decisions live only in memory (Savings Ledger 决策 5).
    await flushLogs();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  // Last resort for exits we do not control (uncaught throw, process.exit
  // elsewhere): async work can no longer run here, so drain synchronously.
  process.on("exit", () => flushLogsSync());

  // Keep process alive
  await new Promise(() => {});
}

/**
 * Listen port from the CLI layer only, or undefined when neither source set
 * one — `startServer` falls back to `config.router.port` in that case.
 *
 * Returning a concrete 8402 here instead made `router.port` in config.yaml
 * dead: it is documented in README and CLAUDE.md but could never take effect,
 * because startServer's `port || config.router.port` never saw a falsy port.
 */
export function resolveListenPort(
  argPort: number | undefined,
  envPort: string | undefined,
): number | undefined {
  if (argPort !== undefined) return argPort;
  const parsed = parseInt(envPort ?? "", 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether this module is the process entry point.
 *
 * npm installs a CLI as a symlink under `node_modules/.bin`. Node resolves
 * `import.meta.url` to the real file but leaves `process.argv[1]` as the
 * symlink it was invoked through, so a raw string compare is false for every
 * `npm i -g` / `npx` / `.bin` invocation — the CLI then exits 0 having printed
 * nothing. Resolve both sides to a real path before comparing.
 */
export function isMainModule(moduleUrl: string, entryPath: string | undefined): boolean {
  if (!entryPath) return false;
  let resolved = entryPath;
  try {
    resolved = realpathSync(entryPath);
  } catch {
    // Entry point does not exist on disk (bundler stub, deleted file): fall
    // back to the raw path rather than crashing before main() can report.
  }
  return moduleUrl === pathToFileURL(resolved).href;
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((err) => {
    console.error(`[NexusRouter] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
