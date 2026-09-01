# 记账金额显示符号切换为人民币 ¥ — 设计文档

> 日期：2026-08-25
> 范围：仅显示层，不涉及内部价格计算或字段名变更

## 背景

当前 dashboard、`stats`、`report` 等输出里金额统一用 `$` 符号展示。用户配置 `priceOverrides` 时直接按人民币填写，因此希望界面上也显示 `¥`。

## 设计结论

**只做显示层替换**：内部数值、日志字段名（`costUsd` / `savedUsd` 等）、schema、计算逻辑全部保持不变；仅在人类可读输出处把 `$` 改成 `¥`。

## 改动范围

| 文件                           | 改动点                                                               |
| ------------------------------ | -------------------------------------------------------------------- |
| `src/dashboard/web.ts`         | 大屏 hero 省钱金额、基线成本、实际成本、最近请求表格成本列、底部注释 |
| `src/stats.ts`                 | `nexusrouter stats` ASCII 报表中的金额行                             |
| `src/report.ts`                | `nexusrouter report` 文本/Markdown 报表                              |
| `src/cli.ts`                   | `stats` / `report` 命令行输出中的金额行                              |
| `src/config/default-config.ts` | 注释中 "USD per 1M tokens" 改为通用 "每 1M tokens 货币单位"          |
| `src/pricing/price-book.ts`    | 注释中 USD 描述改为通用货币单位                                      |
| 相关测试文件                   | 更新对 `$` 符号的断言                                                |

## 明确不做

- 不改 `UsageEntryV2` 字段名（保持 `costUsd` / `savedUsd`）。
- 不加汇率转换、不加 `currency` 配置项。
- 不改价格注册表数值。

## 验收标准

- 大屏所有金额显示 `¥`。
- `nexusrouter stats` / `nexusrouter report` 输出 `¥`。
- 全量测试通过。
