# 01: 插件页运行状态面板

**What to build:** 在 Plugins 里打开本插件的详情页时，能直接看到运行状态（含二进制包与供给目录），并可一键修复；纯 Host 组合的行为不变。

**Blocked by:** —

**Status:** resolved

- [x] Host 半边新注册 `GET /api/labview-mcp.status` 与 `POST /api/labview-mcp.repair` 两条精确 Fetch 路由；`connection` 用可选注入，headless 组合不注册路由。
- [x] 路由视图包含 `status`（与 `labview_mcp_status` 同字段）、`binaryPackage { installed, root }`、`toolsRoot`、`repairing`、`repairError?`、`checkedAt`。
- [x] 修复请求不阻塞、并发只启动一次、`{force:true}` 与工具参数同义；`status()` 抛错时仍返回 200 + `state: 'broken'`。
- [x] 浏览器半边 `client.js`：`plugins.detail.badge` 状态标签 + `plugins.detail.section` 状态卡，仅对 `subject.kind === 'bundle' && subject.pkg.name === 'dsh-labview-mcp'` 渲染。
- [x] 模块级状态源：首个订阅者出现时每 2 s 轮询，订阅者归零即停；修复后立即用 POST 返回的视图刷新。
- [x] EN/ZH 文案经 `ctx.locale.register('labviewMcp', …)` 内联注册；只使用 `--dsw-alias-*` 令牌，不 require 任何 DSH Client 包、不写 DOM。
- [x] `package.json` 增加 `./client` 导出、`files` 与 `dsh.client`；发布脚本的必需条目包含 `client.js`、`status-routes.js`。
- [x] 单测：路由 8 例、client 沙箱 7 例、smoke/metadata 扩展；`npm test` 83 例全绿。
- [x] 本机 rebuilding 本地 tarball、重装插件，确认 Host 半边生效（`labview_mcp_status` / `labview_mcp_repair` / 122 个 `mcp__labview__*` 工具重新注册）。
- [ ] 页面渲染与交互（标签、卡片、Refresh/Repair 点击）——开发环境无浏览器控制，未能目视验证。

## Comments

### Evidence (2026-11-23)

- `npm test`（仓库根）：83 例通过、0 失败。含 `test/status-routes.test.js`、`test/client-bundle.test.js`（`node:vm` 沙箱加载 `client.js`）、`test/smoke.test.js` 的路由注册断言、`test/metadata.test.js` 的清单断言、`scripts/release.test.mjs`（新必需条目通过）。
- 本地 tarball：`npm pack` 产出 17 个条目 / 27,081 B，含 `client.js`、`status-routes.js`；已复制到 `dist/dsh-labview-mcp-1.0.0-local.tgz`（旧包备份为 `dist/dsh-labview-mcp-1.0.0-local.prev-20261123.tgz`）。
- 重装后 `plugin_manager install_bundle` 报 `application: "failed"`，诊断是运行中的 Host 仍把 `labview-mcp` 这一行的 base URL 指向上次 v1 link 安装留下的 `local-bundles\dsh-labview-mcp`（与 v2 迁移时同一个已知问题）。把已安装包复制到该目录、再用 `set_bundle` 关闭/开启后 `application: "applied"`。
- 生效证据：`cordis_inspect_query` host `Tool.listTools` 中重新出现 `labview_mcp_status`、`labview_mcp_repair` 与 `mcp__labview__*`（`mcp__labview__pylv_status` 等）。`index.js` 静态 import `./status-routes.js` 且 `apply` 成功，说明路由模块与插件一起加载。
- 未能验证：HTTP 直接探 `/plugins/…/client.js` 对任何包都返回 404（组合 URL 需要精确 `rev`，已用内置包校准），因此没有拿到"浏览器半边已注册"的运行时证据；页面渲染仍需人工确认。

### Files changed

- `packages/dsh-labview-mcp/status-routes.js`（新）— 精确 Fetch 路由工厂；视图、修复登记、错误姿态。
- `packages/dsh-labview-mcp/client.js`（新）— 浏览器半边：状态源、`plugins.detail.badge`、`plugins.detail.section`、EN/ZH 字典。
- `packages/dsh-labview-mcp/index.js` — `apply` 复用一次 `resolveBinaryPackageRoot()`，`ctx.inject(['connection'], …)` 注册两条路由；工具与 `Config` 契约不变。
- `packages/dsh-labview-mcp/package.json` — `./client` 导出、`files` 增补、`dsh.client { platform: "web", immediately: true }`。
- `scripts/release.mjs` — `PLUGIN_REQUIRED_ENTRIES` 增加 `client.js`、`status-routes.js`。
- `packages/dsh-labview-mcp/test/status-routes.test.js`、`test/client-bundle.test.js`（新）；`test/smoke.test.js`、`test/metadata.test.js`（扩展）。
- `packages/dsh-labview-mcp/README.md`、`locale/en.json`、`locale/zh.json` — 说明插件页可查看状态并修复。
- `docs/adr/0004-runtime-status-in-plugins-page.md`（新）、`.scratch/status-panel/spec.md`（新）、本文件。

### Left in place on purpose

`C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp` 是为了让**当前正在运行的** Host 进程能解析这一行而复制的一份与已安装包逐字节相同的副本。重启 DSH 后加载器会改从 `node_modules\dsh-labview-mcp` 解析，该目录即不再被使用，可安全删除。
