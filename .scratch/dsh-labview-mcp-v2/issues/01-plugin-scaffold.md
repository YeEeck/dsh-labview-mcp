# 01: 可安装的插件骨架

**What to build:** 用户可以在 DSH Plugins 里安装一个最小的 `dsh-labview-mcp` bundle，并在新会话看到两个原生诊断工具；此时还没有 MCP 注册，也没有真实二进制。

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] pnpm workspace 包含 `dsh-labview-mcp` 插件包；`package.json` 声明 `dsh.bundle.patch`，patch 插入一个 Host 插件行。
- [ ] Host 插件导出 `apply(ctx, config)`，注册 `labview_mcp_status` 和 `labview_mcp_repair` 两个原生工具；stub 状态下 `labview_mcp_status` 返回 `state: 'missing'`。
- [ ] 插件包没有任何 runtime dependency、install script 或 build step；安装时不会出现 `pendingBuilds`。
- [ ] 通过 `plugin_manager` 安装本地目录或本地 tarball 后，Plugins 页出现 “LabVIEW MCP (unofficial)” 卡片，新会话能看到两个原生工具。
- [ ] 有一个 smoke test 验证 bundle manifest 有效、插件入口导出 `apply`，并验证两个工具的定义可被注册。
