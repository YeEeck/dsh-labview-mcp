# 04: MCP 注册与生命周期

**What to build:** 供给成功后，插件自动把 LabVIEW MCP 注册到 DSH，用户在新会话看到 `mcp__labview__*` 工具；`labview_mcp_status` 能报告连接与工具数量，`labview_mcp_repair` 能重启注册。

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] 只有 `LabviewService.status().state === 'ready'` 后才调用 `ctx.mcpManager.register('labview', entry)`。
- [ ] 注册项为 stdio：command 指向供给目录的 `LabVIEWMCP.exe`，cwd 指向其 `bin` 目录，`toolCallTimeoutMs` 来自插件 Config（默认 300000）。
- [ ] `labview_mcp_status` 在 ready 时返回 `serverVersion`、`toolCount`、`toolsDir`、`binaryVersion`；新会话出现 `mcp__labview__*` 工具。
- [ ] `labview_mcp_repair` 能 dispose 旧注册并重新注册；重复调用是幂等的，不产生重复进程。
- [ ] 如果 `mcpManager.list()` 中已存在非本插件注册的 `labview`，状态为 `conflict`，不注册，并给出可操作错误。
- [ ] 插件卸载/禁用时，`ctx.effect` 的 disposer 移除 MCP 注册，`LabVIEWMCP.exe` 进程退出。
- [ ] 在 DSH 0.2.2-rc.5 的 new session 中验证 `pylv_status`（或 `mcp__labview__pylv_status`）返回 `ok: true`，`serverVersion` 为 3.1.0。
