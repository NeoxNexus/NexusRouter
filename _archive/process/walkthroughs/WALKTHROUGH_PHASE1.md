# Phase 1 完成报告 — 基础清理与品牌统一

**完成时间**: 2026-03-05  
**验证结果**: typecheck ✅ | build ✅ | 315 → 326 tests ✅

---

## 变更概览

### 1. 错误类型重构

- `src/errors.ts`: 移除支付错误类 → 新增 `ConfigurationError` / `ProviderError` / `ClassificationError` / `RoutingError`
- 新增 `src/errors.test.ts` (17 tests)

### 2. 支付模块删除

- 删除 `src/partners/` (registry.ts / tools.ts / index.ts)
- `src/index.ts`: partners re-export → errors re-export

### 3. models.ts 清理

- `BlockRunModel` → `ModelDefinition` (导出类型)
- `BLOCKRUN_MODELS` → `MODELS` (导出常量)
- 移除 `blockrun/` 前缀剥离逻辑
- 更新 `models.test.ts` (6 tests)

### 4. 品牌统一 (12+ 文件)

| 文件                     | 变更                                       |
| ------------------------ | ------------------------------------------ |
| `package.json`           | `@blockrun/clawrouter` → `nexusrouter`     |
| `config.ts`              | `BLOCKRUN_PROXY_PORT` → `NEXUSROUTER_PORT` |
| `logger.ts` / `stats.ts` | 日志路径 → `~/.nexusrouter/`               |
| `version.ts`             | USER_AGENT → `nexusrouter/`                |
| `updater.ts`             | npm registry → `nexusrouter`               |
| `router/rules.ts`        | 评分器注释 14→15 维                        |

### 5. README + Logo

- 全新像素风 Logo (`docs/pixel_logo.png`)
- 游戏化风格 README (Claude Code + OpenClaw 场景)
