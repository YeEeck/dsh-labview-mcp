# 07: 公开文档与展示元数据

**What to build:** 用户安装前能看懂这是什么、有什么代价；安装后能看到完整的插件卡片、详情页和双语说明。

**Blocked by:** 05, 06

**Status:** ready-for-agent

- [ ] 插件标题为 `LabVIEW MCP (unofficial)`；描述明确说明是 Zuehlke LabVIEW MCP 的非官方 DSH bundle。
- [ ] `locale/en.json` 和 `locale/zh.json` 覆盖 `meta.title`、`meta.description`、`meta.detail`，英文使用 sentence case。
- [ ] 详情页第一屏写明：非官方、Windows x64、首次下载约 57 MB、约 65–75k tokens/请求、如何在 Plugins 页禁用。
- [ ] 图标为原创图形，不使用 NI 或 Zuehlke 的商标/logo，满足 32×32 / 文件格式限制。
- [ ] 包含 `LICENSE`（Zuehlke MIT）、`LICENSE-pylabview.txt`、`THIRD-PARTY-NOTICES.md`，并在 README 中说明来源与许可证。
- [ ] README 覆盖安装、配置（`toolCallTimeoutMs`）、故障排查（missing/broken/conflict/unsupported）、v1 迁移与回滚、发布流程。
- [ ] `package.json` 的 `files` 覆盖入口、patch、locale、详情文档、icon 和许可证；本地安装与实际 `npm pack` 文件清单一致。
- [ ] 通过实际安装检查 Plugins 卡片、详情页、英文和中文文案；无法用浏览器验证的部分在交付报告中明确标注。
