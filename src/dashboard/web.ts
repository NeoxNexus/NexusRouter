/**
 * Web dashboard — served from the router process.
 *
 * Provides:
 *   GET /dashboard        → self-contained HTML page
 *   GET /dashboard/events → SSE stream of live aggregates + recent entries
 *
 * Only registered when `config.router.dashboard` is true. The router default
 * binds loopback only, so the dashboard is not reachable from the LAN unless
 * the user explicitly changes `router.hosts`.
 */

import type { FastifyInstance } from "fastify";
import { watch, type FSWatcher } from "node:fs";
import { resolveLogDir } from "../paths.js";
import { createTailer, tail, type ParsedUsageEntry } from "./tailer.js";
import { emptyAggregates, updateAggregates, type DashboardAggregates } from "./aggregator.js";
import { VERSION } from "../version.js";

export type DashboardWebOptions = {
  enabled: boolean;
  logDir?: string;
  health: () => { enabled: boolean; persist: boolean; degraded: boolean };
  baselineMode: string;
};

type Client = {
  res: NodeJS.WritableStream;
  cleanup: () => void;
};

function formatRecent(entry: ParsedUsageEntry): {
  time: string;
  tier: string;
  model: string;
  tokens: string;
  cache: string;
  cost: string;
  latency: string;
} {
  const date = new Date(entry.timestamp);
  const time = Number.isNaN(date.getTime()) ? entry.timestamp : date.toTimeString().slice(0, 8);
  const usage = entry.usage;
  const tokens = usage
    ? `${(usage.inputUncached + usage.cacheRead + usage.output).toLocaleString("en-US")}/${usage.output.toLocaleString("en-US")}`
    : "—";
  const cache = usage ? `${usage.cacheRead.toLocaleString("en-US")} r` : "—";
  const cost = entry.cost === null ? "—" : `$${entry.cost.toFixed(4)}`;
  const latency = `${entry.latencyMs.toLocaleString("en-US")} ms`;
  return {
    time,
    tier: entry.tier || "UNKNOWN",
    model: entry.model || "unknown",
    tokens,
    cache,
    cost,
    latency,
  };
}

function omitWindowSamples(agg: DashboardAggregates): Omit<DashboardAggregates, "windowSamples"> {
  const { windowSamples: _, ...rest } = agg;
  return rest;
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NexusRouter Dashboard</title>
  <style>
    :root {
      --bg: #0b0c15;
      --panel: #13151f;
      --border: #2a2d3e;
      --text: #c9d1d9;
      --muted: #8b949e;
      --accent: #58a6ff;
      --ok: #3fb950;
      --warn: #d29922;
      --danger: #f85149;
      --saved: #39d0d8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace;
      font-size: 14px;
      line-height: 1.5;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    header h1 { margin: 0; font-size: 18px; color: var(--accent); }
    .status { display: flex; gap: 16px; align-items: center; }
    .status span { font-size: 12px; }
    .online::before { content: "⬤ "; color: var(--ok); }
    .offline::before { content: "○ "; color: var(--danger); }
    .on { color: var(--ok); }
    .off { color: var(--muted); }
    .degraded { color: var(--warn); font-weight: bold; }
    main { padding: 24px; display: grid; grid-template-columns: 360px 1fr; gap: 24px; }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 16px;
    }
    .panel h2 { margin: 0 0 12px; font-size: 13px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; }
    .metric { display: flex; justify-content: space-between; padding: 4px 0; }
    .metric .label { color: var(--muted); }
    .metric .value { font-variant-numeric: tabular-nums; }
    .saved { color: var(--saved); }
    .bar-wrap { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
    .bar-bg { flex: 1; height: 8px; background: #1f2230; border-radius: 4px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--muted); font-weight: normal; padding: 8px; border-bottom: 1px solid var(--border); }
    td { padding: 8px; border-bottom: 1px solid var(--border); font-variant-numeric: tabular-nums; }
    .right { text-align: right; }
    footer {
      padding: 12px 24px;
      border-top: 1px solid var(--border);
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
    }
    .note { color: var(--warn); }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>NexusRouter v${VERSION} · Dashboard</h1>
    <div class="status">
      <span id="conn">connecting…</span>
      <span id="router-status" class="offline">router offline</span>
      <span id="accounting-status" class="off">accounting OFF</span>
      <span id="persist-status" class="off">persist: OFF</span>
    </div>
  </header>
  <main>
    <section class="panel">
      <h2>Today</h2>
      <div class="metric"><span class="label">requests</span><span class="value" id="reqs">—</span></div>
      <div class="metric"><span class="label">actual cost</span><span class="value" id="cost">—</span></div>
      <div id="savings-row" style="display:none">
        <div class="metric"><span class="label">baseline</span><span class="value" id="baseline">—</span></div>
        <div class="metric"><span class="label">saved</span><span class="value saved" id="saved">—</span></div>
      </div>
      <div class="metric"><span class="label">usage src</span><span class="value" id="src">—</span></div>
      <h2 style="margin-top:18px">Throughput (last 60s)</h2>
      <div class="metric"><span class="label">now</span><span class="value" id="tput">— req/s</span></div>
      <div class="metric"><span class="label">p50 latency</span><span class="value" id="p50">—</span></div>
      <div class="metric"><span class="label">p95 latency</span><span class="value" id="p95">—</span></div>
    </section>
    <section class="panel">
      <h2>Routing by Tier</h2>
      <div id="tiers">—</div>
      <h2 style="margin-top:18px">Top Models</h2>
      <table>
        <thead><tr><th>model</th><th class="right">reqs</th><th class="right">cost</th></tr></thead>
        <tbody id="models"><tr><td colspan="3">—</td></tr></tbody>
      </table>
    </section>
  </main>
  <section class="panel" style="margin: 0 24px 24px;">
    <h2>Live</h2>
    <table>
      <thead>
        <tr><th>time</th><th>tier</th><th>model</th><th class="right">tokens</th><th class="right">cache</th><th class="right">cost</th><th class="right">latency</th></tr>
      </thead>
      <tbody id="live"><tr><td colspan="7">waiting for data…</td></tr></tbody>
    </table>
  </section>
  <footer>
    <span id="baseline-note"></span>
    <span>SSE 1s refresh · <span id="last-update">never</span></span>
  </footer>
  <script>
    const fmt = (n, d = 4) => typeof n === "number" ? n.toFixed(d) : "—";
    const pct = (n) => typeof n === "number" ? n.toFixed(1) + "%" : "—";
    const pad = (n) => typeof n === "number" ? n.toLocaleString("en-US") : "—";

    function renderTiers(agg) {
      const order = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"];
      const entries = Object.entries(agg.byTier).sort((a, b) => {
        const ai = order.indexOf(a[0]), bi = order.indexOf(b[0]);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return b[1].count - a[1].count;
      });
      const total = agg.totalRequests || 1;
      document.getElementById("tiers").innerHTML = entries.map(([tier, data]) => {
        const p = (data.count / total) * 100;
        return \`<div class="bar-wrap">
          <span style="width:90px">\${tier}</span>
          <div class="bar-bg"><div class="bar-fill" style="width:\${p.toFixed(1)}%"></div></div>
          <span style="width:60px;text-align:right">\${pct(p)}</span>
          <span style="width:60px;text-align:right">\${pad(data.count)}</span>
        </div>\`;
      }).join("") || "—";
    }

    function renderModels(agg) {
      const rows = Object.entries(agg.byModel).sort((a, b) => b[1].count - a[1].count).slice(0, 8);
      document.getElementById("models").innerHTML = rows.map(([m, d]) =>
        \`<tr><td>\${m}</td><td class="right">\${pad(d.count)}</td><td class="right">\$\${fmt(d.cost)}</td></tr>\`
      ).join("") || \`<tr><td colspan="3">—</td></tr>\`;
    }

    function renderLive(recent) {
      document.getElementById("live").innerHTML = recent.map(e =>
        \`<tr><td>\${e.time}</td><td>\${e.tier}</td><td>\${e.model}</td>
         <td class="right">\${e.tokens}</td><td class="right">\${e.cache}</td>
         <td class="right">\${e.cost}</td><td class="right">\${e.latency}</td></tr>\`
      ).join("") || \`<tr><td colspan="7">no recent requests</td></tr>\`;
    }

    function update(data) {
      const agg = data.aggregates;
      const router = data.router;
      document.getElementById("conn").textContent = "live";
      const rs = document.getElementById("router-status");
      rs.className = router.online ? "online" : "offline";
      rs.textContent = router.online ? "router online" : "router offline";
      const as = document.getElementById("accounting-status");
      as.className = router.enabled ? (router.degraded ? "degraded" : "on") : "off";
      as.textContent = router.enabled ? (router.degraded ? "accounting DEGRADED" : "accounting ON") : "accounting OFF";
      const ps = document.getElementById("persist-status");
      ps.className = router.persist ? "on" : "off";
      ps.textContent = "persist: " + (router.persist ? "ON" : "OFF");

      document.getElementById("reqs").textContent = pad(agg.totalRequests);
      document.getElementById("cost").textContent = "$" + fmt(agg.totalCost);
      const srcParts = [];
      if (agg.upstreamRequests) srcParts.push(pad(agg.upstreamRequests) + " upstream");
      if (agg.estimatedRequests) srcParts.push(pad(agg.estimatedRequests) + " estimated");
      if (agg.partialRequests) srcParts.push(pad(agg.partialRequests) + " partial");
      document.getElementById("src").textContent = srcParts.join(" · ") || "—";

      const savingsRow = document.getElementById("savings-row");
      if (data.baselineMode !== "off" && agg.entriesWithBaseline > 0) {
        savingsRow.style.display = "block";
        document.getElementById("baseline").textContent = "$" + fmt(agg.totalBaselineCost);
        const ratio = agg.totalBaselineCost > 0 ? ((agg.totalSavings / agg.totalBaselineCost) * 100).toFixed(1) : "0.0";
        document.getElementById("saved").textContent = "$" + fmt(agg.totalSavings) + " (" + ratio + "%)";
      } else {
        savingsRow.style.display = "none";
      }

      document.getElementById("tput").textContent = fmt(agg.windowThroughput, 1) + " req/s";
      document.getElementById("p50").textContent = agg.p50Latency === null ? "—" : Math.round(agg.p50Latency) + " ms";
      document.getElementById("p95").textContent = agg.p95Latency === null ? "—" : Math.round(agg.p95Latency) + " ms";

      renderTiers(agg);
      renderModels(agg);
      renderLive(data.recent);

      const note = data.baselineMode === "off" ? "baseline: off" : \`baseline: \${data.baselineMode} (same-usage-repricing · approximate)\`;
      document.getElementById("baseline-note").textContent = note;
      document.getElementById("last-update").textContent = new Date().toLocaleTimeString();
    }

    const es = new EventSource("/dashboard/events");
    es.onmessage = (ev) => {
      try { update(JSON.parse(ev.data)); } catch (err) { console.error("bad sse payload", err); }
    };
    es.onerror = () => {
      document.getElementById("conn").textContent = "reconnecting…";
    };
  </script>
</body>
</html>`;

export function registerDashboardRoutes(app: FastifyInstance, opts: DashboardWebOptions): void {
  if (!opts.enabled) return;

  const logDir = opts.logDir || resolveLogDir();
  const clients = new Set<Client>();
  let tailer = createTailer(logDir);
  let aggregates = emptyAggregates();
  let recent: ParsedUsageEntry[] = [];
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  async function refresh() {
    if (closed || clients.size === 0) return;
    try {
      const event = await tail(tailer);
      const now = Date.now();
      aggregates = updateAggregates(aggregates, event.entries, now);
      if (event.entries.length > 0) {
        recent.push(...event.entries);
        if (recent.length > 200) recent = recent.slice(-200);
      }

      const health = opts.health();
      const payload = {
        aggregates: omitWindowSamples(aggregates),
        recent: recent.slice(-20).reverse().map(formatRecent),
        router: {
          online: true,
          enabled: health.enabled,
          persist: health.persist,
          degraded: health.degraded,
        },
        baselineMode: opts.baselineMode,
      };
      const data = JSON.stringify(payload);
      const dead = new Set<Client>();
      for (const client of clients) {
        try {
          client.res.write(`data: ${data}\n\n`);
        } catch {
          dead.add(client);
        }
      }
      for (const client of dead) {
        client.cleanup();
        clients.delete(client);
      }
      if (clients.size === 0) stopLoop();
    } catch {
      // Never break the router because of a dashboard error.
    }
  }

  function startLoop() {
    if (timer || closed) return;
    timer = setInterval(() => void refresh(), 1000);
    timer.unref();
    try {
      watcher = watch(logDir, () => {
        void refresh();
      });
    } catch {
      // Fall back to polling only.
    }
  }

  function stopLoop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    tailer = createTailer(logDir);
    aggregates = emptyAggregates();
    recent = [];
  }

  app.get("/dashboard", async (_req, reply) => {
    return reply.type("text/html; charset=utf-8").send(HTML);
  });

  app.get("/dashboard/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(":ok\n\n");

    const cleanup = () => {
      try {
        res.end();
      } catch {
        // already closed
      }
      clients.delete(client);
      if (clients.size === 0) stopLoop();
    };
    const client: Client = { res, cleanup };

    const onClose = () => cleanup();
    req.raw.on("close", onClose);
    req.raw.on("error", onClose);

    clients.add(client);
    if (clients.size === 1) startLoop();
    // Send initial frame immediately.
    void refresh();
  });

  app.addHook("onClose", async () => {
    closed = true;
    stopLoop();
    for (const client of clients) client.cleanup();
    clients.clear();
  });
}
