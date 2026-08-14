---
description: 每完成一个 Phase 提交后，对所有改动进行代码评审并生成报告
---

// turbo-all

## 步骤

1. 确认当前最新的 Phase 提交 hash

```bash
git log --oneline -3
```

2. 查看提交的变更文件列表

```bash
git show --stat HEAD
```

3. 对所有变更文件进行深度代码评审，重点检查：
   - 正确性：逻辑错误、边界条件、错误处理（尤其是 stream/网络错误）
   - 安全性：API Key 处理、输入校验、注入风险
   - 性能：不必要的对象创建/序列化、重复计算、单例 vs 每次 new
   - 可维护性：死代码、内联类型、注释与实现不符
   - 类型安全：any 逃逸、as 强转、undefined 未处理
   - 测试覆盖：核心路径是否有用例，边界情况是否测试

4. 生成评审报告到项目根目录

```bash
# 报告命名规范: CODE_REVIEW_PHASE<N>.md
# 内容结构：
# - 🟢 优点
# - 🔴 高优先级问题（必须在下一个 Phase 前修复）
# - 🟡 中优先级问题（本 Phase 内处理）  
# - 🟢 低优先级/建议项
# - 汇总表格 + 下一步建议
```

5. 立即修复报告中所有**高优先级**问题

6. 运行全量测试确认修复后不影响现有功能

// turbo
```bash
npm run typecheck && npm test
```

7. 将评审报告和修复提交到版本控制

```bash
git add -A
git commit -m "review(phaseN): 代码评审报告 + 高优先级问题修复"
```
