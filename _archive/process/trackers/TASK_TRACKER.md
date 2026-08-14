# NexusRouter — Phase 1 Task Tracker

## Phase 1: 基础清理与品牌统一

- [x] **任务 1: 错误类型重构**
  - [x] SDD: 设计新的错误类型接口 (ConfigurationError / ProviderError / ClassificationError / RoutingError)
  - [x] TDD: 编写 `src/errors.test.ts` 测试用例
  - [x] 实现: 替换 `src/errors.ts` 中支付相关错误类
  - [x] 验证: `npx vitest run src/errors.test.ts` 通过 (17/17 ✅)

- [x] **任务 2: 删除 partners/ 模块**
  - [x] 删除 `src/partners/` 目录
  - [x] 清理 `src/index.ts` 中的 partners re-export（替换为 errors re-export）
  - [x] 验证: `npm run typecheck` 通过

- [x] **任务 3: 清理 models.ts BlockRun 引用**
  - [x] TDD: 更新 `src/models.test.ts`（6 个测试全绿）
  - [x] 实现: `BlockRunModel`→`ModelDefinition`、`BLOCKRUN_MODELS`→`MODELS`、移除 blockrun/ 前缀
  - [x] 验证: `npx vitest run src/models.test.ts` 通过

- [x] **任务 4: 清理 compression/ BlockRun 引用**
  - [x] 清理 codebook 中 BlockRun 特定字符串
  - [x] 验证: 压缩功能正常

- [x] **任务 5: 品牌统一**
  - [x] 更新 `package.json` (name/bin/description)
  - [x] 全局清理 9 个文件中的 ClawRouter/BlockRun 引用
  - [x] 验证: `grep -ri "blockrun" src/ --include="*.ts"` 无结果

- [x] **任务 6: 全量回归验证**
  - [x] `npm run typecheck` — 0 errors ✅
  - [x] `npm run build` — dist/ 生成 ✅
  - [x] `npm test` — 14 files, 315 tests passed ✅

- [x] **任务 7: README + Logo 更新**
  - [x] 生成新的 NexusRouter Logo (docs/banner.png)
  - [x] 重写 README.md（愿景、差异化亮点、竞品对比、架构图）
  - [x] 确认无 BlockRun/ClawRouter 残留
