#!/usr/bin/env node
/**
 * NexusRouter load-test CLI.
 *
 * Spins up a local mock OpenAI upstream and a NexusRouter instance, then blasts
 * requests for the configured duration. No real API keys required.
 *
 * Usage:
 *   npm run load-test -- --duration 10 --connections 50
 *   npm run load-test -- --accounting
 */

import { runLoadTest, formatReport } from "../src/load-test/runner.js";

function parseCliArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

function printHelp() {
  console.log(`
NexusRouter Load Test

Runs a local mock upstream + NexusRouter and measures throughput/latency.
No real API keys are required.

Usage:
  npm run load-test -- [options]

Options:
  --duration <seconds>   Test duration (default: 10)
  --connections <n>      Concurrent workers (default: 50)
  --port <n>             Router port; 0 = random (default: 0)
  --accounting           Enable accounting persistence (default: off)
  --stream               Reserved for streaming tests (default: off)
  --help                 Show this help

Examples:
  # 10s, 50 connections, accounting off
  npm run load-test

  # 30s, 100 connections, accounting on
  npm run load-test -- --duration 30 --connections 100 --accounting
`);
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  const durationMs = Math.max(1, Math.round(parseFloat(args.duration || "10") * 1000));
  const connections = Math.max(1, parseInt(args.connections || "50", 10));
  const routerPort = Math.max(0, parseInt(args.port || "0", 10));
  const accounting = args.accounting === "true";

  console.log(`Starting load test: ${(durationMs / 1000).toFixed(1)}s, ${connections} connections, accounting=${accounting ? "ON" : "OFF"}`);

  const result = await runLoadTest({
    durationMs,
    connections,
    routerPort,
    accounting,
    logger: false,
  });

  console.log(formatReport(result));
}

main().catch((err) => {
  console.error("Load test failed:", err);
  process.exit(1);
});
