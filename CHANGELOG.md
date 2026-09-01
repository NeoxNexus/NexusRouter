# Changelog

All notable changes to NexusRouter (formerly ClawRouter).

---

## v0.12.8 — Sep 2026

- **fix(classifier)** — skill documents injected by Claude Code (`Base directory for this skill: …` + SKILL.md body) were scored as user intent, pinning debugging sessions to REASONING via words like "proves" (67/1114 logged requests, D-009); the classification-text extractor now skips skill injections and falls back to the original instruction
- **feat(logging)** — routing log records `activeSkill` when a skill injection was skipped (observability only, no routing weight yet)
- **CI fixed** — the lifecycle/security-scanner integration tests referenced modules that never existed in this repo (`src/proxy.js`, `src/auth.js`) and failed on every run; they are removed and CI now runs the full unit suite on every push
- **Legacy ClawRouter/BlockRun test files deleted** — `test/` contained solana/wallet/x402 leftovers that were never runnable; `test/integration/`, `test/docker/`, `skills/clawrouter/`, the ClawRouter-era `scripts/{install,uninstall,update,reinstall}` helpers and ~10 dead npm scripts removed
- **Dead code deleted** — `src/compression/` (~1,170 lines, never wired), `src/journal.ts`, `src/report.ts`, `src/updater.ts` (placeholder URL), `src/router/llm-classifier.ts`
- **Docs aligned with reality** — README/package.json no longer advertise "15-dimension scoring" as the built-in classifier (it is a library API; the server uses HybridClassifier); library-only exports (SessionStore, RequestDeduplicator, ResponseCache, fetchWithRetry, typed errors) are now explicitly documented as not wired into the server pipeline
- **deploy/new-api template fixed** — added `router.hosts: ["0.0.0.0"]`; the default loopback-only binding made nginx→nexusrouter proxy_pass fail with 502 in Docker
- Lint clean (2 errors fixed), full-repo Prettier pass

## v0.12.7 — Aug 2026

- **fix(cli)** — `nexusrouter` silently exiting after npm install; `router.port` in config.yaml being ignored
- docs: roadmap D-007/D-008, install-level verification notes

## v0.12.6 — Aug 2026

- **fix(routing)** — retry false-positives and inflated confidence on stale text; classification tuning log fields (D-005/D-006)
- **fix(usage-defense)** — fallback-estimation wiring; new-api alignment gaps
- **fix(accounting)** — estimate tokens from text length when upstream omits usage (MiniMax all-zero fix)
- **feat(openai)** — auto-inject `stream_options.include_usage`
- **feat(display)** — amounts shown in ¥
- **fix(classifier)** — one-way ratchet pinning Claude Code traffic to the top two tiers (D-002)
- **fix(cli)** — API-key passthrough on by default; first launch no longer demands a server key

## v0.12.0 – v0.12.5 — Mar–Aug 2026 (consolidated)

- Rebrand ClawRouter → NexusRouter; baseline deployment on `deploy/new-api` (nginx + passthrough keys)
- Embedded default config template auto-created at `~/.nexus-router/config.yaml` on first launch; unified log/cache paths under `~/.nexus-router`
- HybridClassifier overhaul: word-boundary keywords, tool-intent detection, Claude Code injection stripping, thinking toggle (D-001); Layer 2 gains an OpenAI-compatible provider (new-api / vLLM)
- Savings Ledger: tiered pricing + counterfactual baseline, ledger batch writer, usage capture, `stats`/`report` CLI subcommands
- Web dashboard at `/dashboard` (SSE, Chinese metrics, savings display) replacing the terminal TUI
- Server binds loopback dual-stack by default; `router.hosts` to expose explicitly
- Local load-test baseline tooling

---

## v0.11.11 — Mar 2, 2026

- **Input token logging** — usage logs now include `inputTokens` from provider responses

## v0.11.10 — Mar 2, 2026

- **Gemini 3.x in allowlist** — replaced Gemini 2.5 with Gemini 3.1 Pro and Gemini 3 Flash Preview

## v0.11.9 — Mar 2, 2026

- **Top 16 model allowlist** — trimmed from 88 to 16 curated models in `/model` picker (4 routing profiles + 12 popular models)

## v0.11.8 — Mar 2, 2026

- **Populate model allowlist** — populate `agents.defaults.models` with BlockRun models so they appear in `/model` picker

## v0.11.7 — Mar 1, 2026

- **Auto-fix broken allowlist** — `injectModelsConfig()` detects and removes blockrun-only allowlist on every gateway start

## v0.11.6 — Mar 1, 2026

- **Allowlist cleanup in reinstall.sh** — detect and remove blockrun-only allowlist that hid all other models

## v0.11.5 — Mar 1, 2026

- **`clawrouter report` command** — daily/weekly/monthly usage reports via `npx @blockrun/clawrouter report`
- **`clawrouter doctor` command** — AI diagnostics for troubleshooting

## v0.11.4 — Mar 1, 2026

- **catbox.moe image hosting** — `/imagegen` uploads base64 data URIs to catbox.moe (replaces broken telegra.ph)

## v0.11.3 — Mar 1, 2026

- **Image upload for Telegram** — base64 data URIs from Google image models converted to hosted URLs

## v0.11.2 — Feb 28, 2026

- **Output raw image URL** — `/imagegen` returns plain URL instead of markdown syntax for Telegram compatibility

---

## v0.11.0 / v0.11.1 — Feb 28, 2026

### Three-Strike Escalation

Session-level repetition detection: 3 consecutive identical request hashes auto-escalate to the next tier (SIMPLE → MEDIUM → COMPLEX → REASONING). Fixes Kimi K2.5 agentic loop problem without manual model switching.

### `/imagegen` command

Generate images from chat. Calls BlockRun's image generation API with x402 micropayments.

```
/imagegen a cat wearing sunglasses
/imagegen --model dall-e-3 a futuristic city
/imagegen --model banana-pro --size 2048x2048 landscape
```

| Model                        | Shorthand     | Price                  |
| ---------------------------- | ------------- | ---------------------- |
| Google Nano Banana (default) | `nano-banana` | $0.05/image            |
| Google Nano Banana Pro       | `banana-pro`  | $0.10/image (up to 4K) |
| OpenAI DALL-E 3              | `dall-e-3`    | $0.04/image            |
| OpenAI GPT Image 1           | `gpt-image`   | $0.02/image            |
| Black Forest Flux 1.1 Pro    | `flux`        | $0.04/image            |

---

## v0.10.20 / v0.10.21 — Feb 27, 2026

- **Stop hijacking model picker** — removed allowlist injection that hid non-BlockRun models from `/model` picker
- **Silent fallback to free model** — insufficient funds now skips remaining paid models and jumps to `nvidia/gpt-oss-120b` instead of showing payment errors

---

## v0.10.19 — Feb 27, 2026

- **Anthropic array content extraction** — routing now handles `[{type:"text", text:"..."}]` content format (was extracting empty string)
- **Session startup bias fix** — never-downgrade logic: sessions can upgrade tiers but won't lock to the low-complexity startup message tier

---

## v0.10.18 — Feb 26, 2026

- **Session re-pins to fallback** — after provider failure, session updates to the actual model that responded instead of retrying the failing primary every turn

---

## v0.10.16 / v0.10.17 — Feb 26, 2026

- **`/debug` command** — type `/debug <prompt>` to see routing diagnostics (tier, model, scores, session state) with zero API cost
- **Tool-calling model filter** — requests with tool schemas skip incompatible models automatically
- **Session persistence enabled by default** — `deriveSessionId()` hashes first user message; model stays pinned 30 min without client headers
- **baselineCost fix** — hardcoded Opus 4.6 fallback pricing so savings metric always calculates correctly

---

## v0.10.12 – v0.10.15 — Feb 26, 2026

- **Tool call leaking fix** — removed `grok-code-fast-1` from all routing paths (was outputting tool invocations as plain text)
- **Systematic tool-calling guard** — `toolCalling` flag on models; incompatible models filtered from fallback chains
- **Async plugin fix** — `register()` made synchronous; OpenClaw was silently skipping initialization

---

## v0.10.9 — Feb 24, 2026

- **Agentic mode false trigger** — `agenticScore` now scores user prompt only, not system prompt. Coding assistant system prompts no longer force all requests to Sonnet.

---

## v0.10.8 — Feb 24, 2026

- **OpenClaw tool API contract** — fixed `inputSchema` → `parameters`, `execute(args)` → `execute(toolCallId, params)`, and return format

---

## v0.10.7 — Feb 24, 2026

- **Partner tool trigger reliability** — directive tool description so AI calls the tool instead of answering from memory
- **Baseline cost fix** — `BASELINE_MODEL_ID` corrected from `claude-opus-4-5` to `claude-opus-4.6`
- **Wallet corruption safety** — corrupted wallet files throw with recovery instructions instead of silently generating new wallet

---

## v0.10.5 — Feb 22, 2026

- **9-language router** — added ES, PT, KO, AR keywords across all 12 scoring dimensions (was 5 languages)

---

## v0.10.0 — Feb 21, 2026

- **Claude 4.6** — all Claude models updated to newest Sonnet 4.6 / Opus 4.6
- **7 new models** — total 41 (Gemini 3.1 Pro Preview, Gemini 2.5 Flash Lite, o1, o1-mini, gpt-4.1-nano, grok-2-vision)
- **5 pricing fixes** — 15-30% better routing from corrected model costs
- **67% cheaper ECO tier** — Flash Lite for MEDIUM/COMPLEX
