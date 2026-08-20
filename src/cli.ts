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
 *
 * For production deployments, use with PM2:
 *   pm2 start "npx nexusrouter" --name nexusrouter
 */

import { startServer } from "./server.js";
import { VERSION } from "./version.js";
import { getDefaultConfigPath, ensureConfigExists } from "./config/loader.js";
import { flushLogs, flushLogsSync } from "./logger.js";

/** Human-readable default config path, tuned per OS for the help text. */
function defaultConfigHint(): string {
  return process.platform === "win32"
    ? "%USERPROFILE%\\.nexus-router\\config.yaml"
    : "~/.nexus-router/config.yaml";
}

function printHelp(): void {
  console.log(`
NexusRouter v${VERSION} - Smart LLM Router (Direct API, No Payments)

Usage:
  nexusrouter [options]
  nexusrouter doctor [question]

Options:
  --version, -v     Show version number
  --help, -h        Show this help message
  --port <number>   Port to listen on (default: 8402)
  --config <path>   Path to config file
                    (default: ${defaultConfigHint()})
                    resolved to: ${getDefaultConfigPath()}
                    Created automatically on first launch if missing.

Commands:
  doctor            AI-powered diagnostics

Examples:
  # Start server
  npx nexusrouter

  # Run diagnostics
  npx nexusrouter doctor "why is my request failing?"

Environment Variables:
  OPENAI_API_KEY      OpenAI API key
  ANTHROPIC_API_KEY   Anthropic API key
  GOOGLE_API_KEY      Google API key
  NEXUSROUTER_PORT    Default server port (default: 8402)

For more info: https://github.com/neochen2286-rgb/NexusRouter
`);
}

function parseArgs(args: string[]): {
  version: boolean;
  help: boolean;
  doctor: boolean;
  doctorQuestion?: string;
  port?: number;
  config?: string;
} {
  const result = {
    version: false,
    help: false,
    doctor: false,
    doctorQuestion: undefined as string | undefined,
    port: undefined as number | undefined,
    config: undefined as string | undefined,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "doctor" || arg === "--doctor") {
      result.doctor = true;
      // Collect remaining args as question
      result.doctorQuestion =
        args
          .slice(i + 1)
          .join(" ")
          .trim() || undefined;
      break;
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
    // TODO: Implement doctor command without wallet
    console.log("Doctor command not yet implemented for NexusRouter");
    process.exit(0);
  }

  // Start the server
  const port = args.port || parseInt(process.env.NEXUSROUTER_PORT || "8402", 10);

  // Resolve config path: explicit --config wins; otherwise the home-dir
  // default, which is auto-created from the template on first launch.
  const configPath = args.config ?? getDefaultConfigPath();
  if (!args.config) {
    const { created } = await ensureConfigExists(configPath);
    if (created) {
      console.log(
        `✅ 已创建默认配置：${configPath}\n` +
          `请填写 API Key（或设置对应环境变量）后重新启动 nexusrouter。`,
      );
      process.exit(0);
    }
  }

  console.log(`[NexusRouter] Starting server on port ${port}...`);

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

main().catch((err) => {
  console.error(`[NexusRouter] Fatal error: ${err.message}`);
  process.exit(1);
});
