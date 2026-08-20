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
  const rest = { ...agg };
  delete (rest as { windowSamples?: DashboardAggregates["windowSamples"] }).windowSamples;
  return rest as Omit<DashboardAggregates, "windowSamples">;
}

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>NexusRouter 实时大屏</title>
  <style>
    :root {
      --bg: #030508;
      --panel: rgba(10, 14, 24, 0.82);
      --border: rgba(0, 240, 255, 0.18);
      --text: #e0f7ff;
      --muted: #5f7a8a;
      --cyan: #00f0ff;
      --green: #00ff9d;
      --purple: #b829dd;
      --warn: #ffcc00;
      --danger: #ff2a6d;
      --saved: #00ff9d;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, "PingFang SC", "Microsoft YaHei", monospace;
      font-size: 14px;
      line-height: 1.5;
      overflow-x: hidden;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -2;
      background:
        radial-gradient(circle at 20% 20%, rgba(0, 240, 255, 0.08) 0%, transparent 40%),
        radial-gradient(circle at 80% 80%, rgba(184, 41, 221, 0.08) 0%, transparent 40%),
        linear-gradient(rgba(0, 240, 255, 0.04) 1px, transparent 1px),
        linear-gradient(90deg, rgba(0, 240, 255, 0.04) 1px, transparent 1px);
      background-size: 100% 100%, 100% 100%, 40px 40px, 40px 40px;
      animation: gridMove 8s linear infinite;
    }
    @keyframes gridMove {
      0% { background-position: 0 0, 0 0, 0 0, 0 0; }
      100% { background-position: 0 0, 0 0, 40px 40px, 40px 40px; }
    }
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      z-index: -1;
      background: linear-gradient(180deg, transparent 0%, rgba(0, 240, 255, 0.03) 50%, transparent 100%);
      background-size: 100% 200%;
      animation: scan 6s linear infinite;
      pointer-events: none;
    }
    @keyframes scan {
      0% { background-position: 0 -100%; }
      100% { background-position: 0 200%; }
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 18px 28px;
      border-bottom: 1px solid var(--border);
      background: rgba(0, 240, 255, 0.04);
      backdrop-filter: blur(6px);
    }
    header h1 {
      margin: 0;
      font-size: 20px;
      color: var(--cyan);
      text-shadow: 0 0 12px rgba(0, 240, 255, 0.5);
      letter-spacing: 1px;
    }
    .status { display: flex; gap: 18px; align-items: center; }
    .status span { font-size: 12px; }
    .online::before { content: "● "; color: var(--green); }
    .offline::before { content: "○ "; color: var(--danger); }
    .on { color: var(--green); text-shadow: 0 0 8px rgba(0, 255, 157, 0.4); }
    .off { color: var(--muted); }
    .degraded { color: var(--warn); font-weight: bold; animation: blink 1.5s infinite; }
    @keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .hero {
      margin: 28px;
      padding: 28px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: linear-gradient(135deg, rgba(0, 240, 255, 0.08), rgba(184, 41, 221, 0.08));
      box-shadow: 0 0 30px rgba(0, 240, 255, 0.12), inset 0 0 20px rgba(0, 240, 255, 0.05);
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .hero::before {
      content: "";
      position: absolute;
      top: -2px; left: -2px; right: -2px; bottom: -2px;
      background: linear-gradient(90deg, transparent, var(--cyan), transparent);
      z-index: -1;
      opacity: 0.3;
      animation: borderRotate 4s linear infinite;
    }
    @keyframes borderRotate {
      0% { transform: rotate(0deg); }
      100% { transform: rotate(360deg); }
    }
    .hero-label { font-size: 14px; color: var(--muted); letter-spacing: 2px; }
    .hero-value {
      margin-top: 8px;
      font-size: 56px;
      font-weight: 700;
      color: var(--saved);
      text-shadow: 0 0 20px rgba(0, 255, 157, 0.6), 0 0 40px rgba(0, 255, 157, 0.3);
      animation: savedPulse 2s ease-in-out infinite;
    }
    @keyframes savedPulse {
      0%,100% { transform: scale(1); text-shadow: 0 0 20px rgba(0, 255, 157, 0.6); }
      50% { transform: scale(1.03); text-shadow: 0 0 35px rgba(0, 255, 157, 0.9); }
    }
    .hero-sub { margin-top: 6px; font-size: 14px; color: var(--muted); }
    main {
      padding: 0 28px 28px;
      display: grid;
      grid-template-columns: 340px 1fr;
      gap: 24px;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 18px;
      backdrop-filter: blur(4px);
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }
    .panel h2 {
      margin: 0 0 14px;
      font-size: 13px;
      color: var(--cyan);
      letter-spacing: 2px;
      text-transform: uppercase;
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
    }
    .metric { display: flex; justify-content: space-between; padding: 5px 0; }
    .metric .label { color: var(--muted); }
    .metric .value { font-variant-numeric: tabular-nums; color: var(--text); }
    .value.saved { color: var(--saved); font-weight: bold; }
    .bar-wrap { display: flex; align-items: center; gap: 10px; margin: 8px 0; }
    .bar-bg {
      flex: 1;
      height: 10px;
      background: rgba(255,255,255,0.06);
      border-radius: 5px;
      overflow: hidden;
      box-shadow: inset 0 0 6px rgba(0,0,0,0.5);
    }
    .bar-fill {
      height: 100%;
      border-radius: 5px;
      background: linear-gradient(90deg, var(--cyan), var(--purple));
      background-size: 200% 100%;
      animation: shimmer 2.5s linear infinite;
      box-shadow: 0 0 10px rgba(0, 240, 255, 0.4);
    }
    @keyframes shimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; color: var(--muted); font-weight: normal; padding: 8px; border-bottom: 1px solid var(--border); }
    td { padding: 8px; border-bottom: 1px solid rgba(0, 240, 255, 0.08); font-variant-numeric: tabular-nums; }
    .right { text-align: right; }
    footer {
      margin: 0 28px 28px;
      padding: 14px 18px;
      border: 1px solid var(--border);
      border-radius: 8px;
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      background: var(--panel);
    }
    @media (max-width: 900px) {
      main { grid-template-columns: 1fr; }
      .hero-value { font-size: 36px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>NexusRouter v${VERSION} · 实时路由大屏</h1>
    <div class="status">
      <span id="conn">连接中…</span>
      <span id="router-status" class="offline">Router 离线</span>
      <span id="accounting-status" class="off">记账 OFF</span>
      <span id="persist-status" class="off">落盘: OFF</span>
    </div>
  </header>

  <section class="hero">
    <div class="hero-label">💰 今日已省（反事实基线估算）</div>
    <div class="hero-value" id="hero-saved">—</div>
    <div class="hero-sub" id="hero-ratio">节省比例 —</div>
  </section>

  <main>
    <section class="panel">
      <h2>今日概览</h2>
      <div class="metric"><span class="label">总请求数</span><span class="value" id="reqs">—</span></div>
      <div class="metric"><span class="label">实际成本</span><span class="value" id="cost">—</span></div>
      <div class="metric" id="baseline-row" style="display:none"><span class="label">基线成本</span><span class="value" id="baseline">—</span></div>
      <div class="metric"><span class="label">Usage 来源</span><span class="value" id="src">—</span></div>
      <h2 style="margin-top:20px">实时流量（60s 窗口）</h2>
      <div class="metric"><span class="label">当前吞吐</span><span class="value" id="tput">— req/s</span></div>
      <div class="metric"><span class="label">p50 延迟</span><span class="value" id="p50">—</span></div>
      <div class="metric"><span class="label">p95 延迟</span><span class="value" id="p95">—</span></div>
    </section>
    <section class="panel">
      <h2>档位分布</h2>
      <div id="tiers">—</div>
      <h2 style="margin-top:20px">热门模型 TOP8</h2>
      <table>
        <thead><tr><th>模型</th><th class="right">请求数</th><th class="right">成本</th></tr></thead>
        <tbody id="models"><tr><td colspan="3">—</td></tr></tbody>
      </table>
    </section>
  </main>

  <section class="panel" style="margin: 0 28px 28px;">
    <h2>实时请求</h2>
    <table>
      <thead>
        <tr><th>时间</th><th>档位</th><th>模型</th><th class="right">输入/输出</th><th class="right">缓存</th><th class="right">成本</th><th class="right">延迟</th></tr>
      </thead>
      <tbody id="live"><tr><td colspan="7">等待数据…</td></tr></tbody>
    </table>
  </section>

  <footer>
    <span id="baseline-note"></span>
    <span>SSE 实时推送 · 上次更新 <span id="last-update">—</span></span>
  </footer>

  <script>
    function fmt(n, d) {
      d = d === undefined ? 4 : d;
      return typeof n === 'number' ? n.toFixed(d) : '—';
    }
    function pct(n) {
      return typeof n === 'number' ? n.toFixed(1) + '%' : '—';
    }
    function pad(n) {
      return typeof n === 'number' ? n.toLocaleString('en-US') : '—';
    }

    function renderTiers(agg) {
      var order = ['SIMPLE', 'MEDIUM', 'COMPLEX', 'REASONING'];
      var entries = Object.entries(agg.byTier).sort(function(a, b) {
        var ai = order.indexOf(a[0]), bi = order.indexOf(b[0]);
        if (ai !== -1 && bi !== -1) return ai - bi;
        if (ai !== -1) return -1;
        if (bi !== -1) return 1;
        return b[1].count - a[1].count;
      });
      var total = agg.totalRequests || 1;
      document.getElementById('tiers').innerHTML = entries.map(function(item) {
        var tier = item[0], data = item[1];
        var p = (data.count / total) * 100;
        return '<div class="bar-wrap">' +
          '<span style="width:80px">' + tier + '</span>' +
          '<div class="bar-bg"><div class="bar-fill" style="width:' + p.toFixed(1) + '%"></div></div>' +
          '<span style="width:55px;text-align:right">' + pct(p) + '</span>' +
          '<span style="width:55px;text-align:right">' + pad(data.count) + '</span>' +
          '</div>';
      }).join('') || '—';
    }

    function renderModels(agg) {
      var rows = Object.entries(agg.byModel).sort(function(a, b) { return b[1].count - a[1].count; }).slice(0, 8);
      document.getElementById('models').innerHTML = rows.map(function(item) {
        var m = item[0], d = item[1];
        return '<tr><td>' + m + '</td><td class="right">' + pad(d.count) + '</td><td class="right">$' + fmt(d.cost) + '</td></tr>';
      }).join('') || '<tr><td colspan="3">—</td></tr>';
    }

    function renderLive(recent) {
      document.getElementById('live').innerHTML = recent.map(function(e) {
        return '<tr><td>' + e.time + '</td><td>' + e.tier + '</td><td>' + e.model + '</td>' +
          '<td class="right">' + e.tokens + '</td><td class="right">' + e.cache + '</td>' +
          '<td class="right">' + e.cost + '</td><td class="right">' + e.latency + '</td></tr>';
      }).join('') || '<tr><td colspan="7">暂无实时请求</td></tr>';
    }

    function update(data) {
      var agg = data.aggregates;
      var router = data.router;
      document.getElementById('conn').textContent = '已连接';
      var rs = document.getElementById('router-status');
      rs.className = router.online ? 'online' : 'offline';
      rs.textContent = router.online ? 'Router 在线' : 'Router 离线';
      var as = document.getElementById('accounting-status');
      as.className = router.enabled ? (router.degraded ? 'degraded' : 'on') : 'off';
      as.textContent = router.enabled ? (router.degraded ? '记账 DEGRADED' : '记账 ON') : '记账 OFF';
      var ps = document.getElementById('persist-status');
      ps.className = router.persist ? 'on' : 'off';
      ps.textContent = '落盘: ' + (router.persist ? 'ON' : 'OFF');

      document.getElementById('reqs').textContent = pad(agg.totalRequests);
      document.getElementById('cost').textContent = '$' + fmt(agg.totalCost);

      var srcParts = [];
      if (agg.upstreamRequests) srcParts.push(pad(agg.upstreamRequests) + ' 上游');
      if (agg.estimatedRequests) srcParts.push(pad(agg.estimatedRequests) + ' 估算');
      if (agg.partialRequests) srcParts.push(pad(agg.partialRequests) + ' 部分');
      document.getElementById('src').textContent = srcParts.join(' · ') || '—';

      var baselineRow = document.getElementById('baseline-row');
      var heroSaved = document.getElementById('hero-saved');
      var heroRatio = document.getElementById('hero-ratio');
      if (data.baselineMode !== 'off' && agg.entriesWithBaseline > 0) {
        baselineRow.style.display = 'flex';
        document.getElementById('baseline').textContent = '$' + fmt(agg.totalBaselineCost);
        var ratio = agg.totalBaselineCost > 0 ? ((agg.totalSavings / agg.totalBaselineCost) * 100).toFixed(1) : '0.0';
        heroSaved.textContent = '$' + fmt(agg.totalSavings);
        heroRatio.textContent = '对比基线节省 ' + ratio + '% · 基于 same-usage-repricing 估算';
      } else {
        baselineRow.style.display = 'none';
        heroSaved.textContent = '—';
        heroRatio.textContent = '基线模式关闭或未配置';
      }

      document.getElementById('tput').textContent = fmt(agg.windowThroughput, 1) + ' req/s';
      document.getElementById('p50').textContent = agg.p50Latency === null ? '—' : Math.round(agg.p50Latency) + ' ms';
      document.getElementById('p95').textContent = agg.p95Latency === null ? '—' : Math.round(agg.p95Latency) + ' ms';

      renderTiers(agg);
      renderModels(agg);
      renderLive(data.recent);

      var note = data.baselineMode === 'off' ? '基线模式: 关闭' : '基线: ' + data.baselineMode + '（same-usage-repricing · 近似值）';
      document.getElementById('baseline-note').textContent = note;
      document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
    }

    var es = new EventSource('/dashboard/events');
    es.onmessage = function(ev) {
      try { update(JSON.parse(ev.data)); } catch (err) { console.error('SSE 数据解析失败', err); }
    };
    es.onerror = function() {
      document.getElementById('conn').textContent = '重连中…';
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
