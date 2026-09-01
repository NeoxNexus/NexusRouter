# 架构设计与性能红线 (Architecture & Performance)

## 一、绝对的向后兼容性 (Strict Backward Compatibility)

任何新端点或新 Agent（如 Claude Code）的集成，**绝对不能**破坏现有核心功能和已集成系统（如 OpenClaw）的运行状态与用户配置，必须做到**零感知升级**。

## 二、恰当运用设计模式解耦 (Design Patterns Apply)

- 拒绝面条代码与补丁式堆砌。由于不同 Agent 不具有通用性，绝不生搬硬套。
- 根据场景合理采用以下模式，实现良好的可拓展性：
  - **策略模式**: 如各种协议 Adapter
  - **插件模式**: 如扩展不同 Agent Profile
  - **责任链模式**: 统一请求流水线

## 三、毫秒必争的性能底线 (Zero-Overhead Mental Model)

作为处于流量咽喉部位的代理路由层，必须极度关注延迟与内存。代码是系统的倒影，追求高内聚低耦合，坚守性能底线。

- **Passthrough 原则**: 同协议应走 Passthrough 跳过解析。
- **内存优化**: 避免不必要的对象实例化。
- **底层资源**: 关注并妥善释放 Stream 读取锁等流控资源。
