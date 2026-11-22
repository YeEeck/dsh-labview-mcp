# 05: desktop E2E 与 v1 迁移

**What to build:** 在 `desktop` profile 上完成一次可回滚的 v1 → v2 迁移，并证明“安装 → 供给 → 注册 → 使用 → 卸载”整条路径成立。

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] 迁移前备份 v1 的 `local-bundles/dsh-labview-mcp`，并记录回滚命令。
- [ ] 从 profile 移除 v1 bundle，确认 `mcpManager.list()` 不再有 `labview` 配置项。
- [ ] 通过 `plugin_manager` 安装本地构建的 v2 tarball；`labview_mcp_status` 最终为 `ready`。
- [ ] 新建会话能看到 `mcp__labview__*` 工具，工具数量与上游 v3.1.0 实际数量一致（v3.0.4 为 121，需实测确认）。
- [ ] `pylv_status` 返回 `ok: true`，`serverVersion` 正确，`aixmlBackend.pylabviewAvailable: true`；`grpcService.reachable: false` 在当前 LabVIEW 2023 上视为正常。
- [ ] 卸载 v2 后：`LabVIEWMCP.exe` 进程消失、工具从新会话消失、`node_modules` 中没有运行中的 exe 句柄。
- [ ] v2 验证通过后，删除旧的 `%USERPROFILE%\.dsh\tools\labview-mcp\current` 目录，回收约 178 MB。
- [ ] 将上述步骤写成可复制的迁移/回滚清单；若任一步失败，能按清单恢复 v1。
