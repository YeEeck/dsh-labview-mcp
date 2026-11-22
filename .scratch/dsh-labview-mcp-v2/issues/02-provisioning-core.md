# 02: 版本化供给核心

**What to build:** `labview_mcp_status` 从一个 fixture 二进制包读取运行树，把它复制到版本化工具目录，并正确报告 `missing` / `provisioning` / `ready` / `broken` / `unsupported` 状态；此阶段不注册 MCP。

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] `LabviewService` 提供 `status()` / `ensure()` / `repair()` / `dispose()`，可由测试注入 `toolsRoot`、`binaryPackageRoot`、`platform` 和 `arch`。
- [ ] 供给先写 `.staging-<guid>`，成功后再原子 rename 为 `<binaryVersion>/`；半成品不会被报告为 `ready`。
- [ ] 同一版本重复 `ensure()` 不重复复制；保留最近两个版本目录；不会删除正在运行的版本。
- [ ] `status` 覆盖 `missing`、`provisioning`、`ready`、`broken`、`unsupported`；`repair({ force: true })` 可强制重新复制。
- [ ] 单元测试使用临时目录和 fixture 二进制包，覆盖 fresh install、幂等、partial stage 恢复、三个版本的保留、unsupported、missing binary、manifest 不匹配。
- [ ] 单元测试只断言外部行为（返回状态、文件存在/不存在、目录数量），不断言内部私有函数。
