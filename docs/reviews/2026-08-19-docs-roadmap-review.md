# Phase 3 文档与 Roadmap 对齐评审报告

> 评审日期：2026-08-19  
> 评审范围：ROADMAP.md、README.md、docs/ 核心文档、package.json、openclaw.\*.json  
> 分支：`docs/phase3-roadmap-and-docs`  
> 状态：✅ 通过，无高优先级阻塞项

---

## 1. 评审目标

确认本次提交成功将 `deploy/new-api/`（nginx + NexusRouter + new-api passthrough）提升为项目官方远程部署基线，并清理了用户可见的 ClawRouter/BlockRun/x402/wallet 残留叙事。

---

## 2. 变更摘要

| 文件/目录                                    | 操作 | 说明                                                                    |
| :------------------------------------------- | :--- | :---------------------------------------------------------------------- |
| `ROADMAP.md`                                 | 更新 | 部署基线从 Phase 7 提前至 Phase 3.7；Phase 7 改为基于锁定基线的性能调优 |
| `README.md`                                  | 重写 | 增加生产部署章节、修正模型名、修正 Claude Code URL                      |
| `docs/usage-manual.md`                       | 更新 | 第 8 章增加 Docker/Compose 一键部署指向 `deploy/new-api/`               |
| `docs/architecture.md`                       | 重写 | 替换为当前 ProtocolAdapter → AgentProfile → HybridClassifier 架构       |
| `docs/configuration.md`                      | 重写 | 当前 YAML/Zod schema、`passthroughApiKey` 说明                          |
| `docs/installation.md`                       | 重写 | 移除 OpenClaw plugin 旧说明，增加 Docker 部署路径                       |
| `docs/troubleshooting.md`                    | 重写 | 移除 wallet/x402 内容，增加当前 FAQ                                     |
| `docs/features.md`                           | 重写 | 区分"已接入"与"已实现但未接线"能力                                      |
| `docs/routing-profiles.md`                   | 重写 | 用 SIMPLE/MEDIUM/COMPLEX/REASONING 替代 ECO/AUTO/PREMIUM/AGENTIC        |
| `package.json`                               | 更新 | repository URL、keywords、author                                        |
| `openclaw.plugin.json`                       | 重写 | id/name → nexusrouter，移除 wallet 配置                                 |
| `openclaw.security.json`                     | 重写 | 声明无特权环境访问、无支付签名                                          |
| `_archive/docs/` / `_archive/process/specs/` | 归档 | 旧 ClawRouter 部署与 failover 文档                                      |

---

## 3. 质量门禁

| 门禁       | 命令                                              | 结果              |
| :--------- | :------------------------------------------------ | :---------------- |
| 类型检查   | `npm run typecheck`                               | ✅ 0 errors       |
| 构建       | `npm run build`                                   | ✅ 成功           |
| 测试       | `npm test`                                        | ✅ 419/419 passed |
| 格式化     | `npx prettier --check <modified files>`           | ✅ 通过           |
| 旧品牌扫雷 | grep ClawRouter/BlockRun/x402/wallet/USDC/payment | ✅ 活跃文档无残留 |

---

## 4. 发现项

### 4.1 低优先级

1. **历史文档未完全清理**
   - `docs/plans/2026-02-03-smart-routing-design.md`、`docs/plans/WALKTHROUGH.md` 等仍保留 ClawRouter/BlockRun 历史记录。
   - **结论**：这些是历史过程产物，本次未处理。建议在 Phase 3.5 "文档与品牌统一" 时评估是否归档。

2. **README 仍保留 8-bit 风格**
   - 游戏化隐喻（MP、Boss、技能点）仍保留，符合项目既有视觉风格。
   - **结论**：接受，未变更。

3. **OpenClaw plugin id 变更的兼容性**
   - `openclaw.plugin.json` 的 `id` 从 `clawrouter` 改为 `nexusrouter`，现有 OpenClaw 用户需要重新安装插件。
   - **结论**：已在计划阶段与用户确认，按干净重品牌执行。

---

## 5. 未解决问题

- **D-001 残留**：`src/router/` 完整能力与 `models.ts` 双配置源问题未在本次文档任务中解决。`ROADMAP.md` 中已保留该阻塞项，待后续 Phase 3.3 处理。

---

## 6. 验收结论

- ✅ Roadmap 正确反映部署基线现状
- ✅ 核心用户文档全部指向 `deploy/new-api/` 作为官方远程部署方案
- ✅ 活跃文档无 ClawRouter/BlockRun/x402/wallet 残留
- ✅ 三道质量门禁 100% 通过

**建议：允许合并到 main。**

---

## 7. 提交记录

```text
6349c88 docs: archive obsolete ClawRouter-era docs
1d81be9 docs: update ROADMAP.md to lock deploy/new-api baseline in Phase 3
f58b934 chore: update package metadata and OpenClaw plugin for NexusRouter rebrand
ad8f86b docs: rewrite README and core docs for new-api deployment baseline
```
