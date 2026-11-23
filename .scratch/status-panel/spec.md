# Spec: 插件页运行状态面板

## Problem Statement

运行状态目前只存在于两个原生工具里：`labview_mcp_status` 与 `labview_mcp_repair`。用户想知道"二进制包到底装没装、运行树供给到哪一步、MCP 注册是不是被同名服务器占住"，必须先开一个会话、让模型去调用工具。而 Plugins 页恰恰是用户管理插件的地方，却只显示版本、开关和"是否运行"，看不到本插件最关键的事实——它依赖一个随包安装的 Windows x64 二进制包。

## Solution

给 bundle 增加浏览器半边 `client.js`：在插件自己的详情页画一个状态标签（`plugins.detail.badge`）和一张运行状态卡（`plugins.detail.section`）。数据由 Host 半边新注册的两条精确 Fetch 路由提供；卡片可刷新、可直接修复（等价 `labview_mcp_repair`）。Host 侧在无浏览器载体的组合里完全不受影响。

## User Stories

1. 作为 DSH 用户，我希望打开 Plugins 里的本插件页就能看到运行状态，不必开会话。
2. 作为 DSH 用户，我希望看到二进制包 `dsh-labview-mcp-win32-x64` 是否已解析到、运行树目录在哪，从而分清"缺依赖"和"供给失败"。
3. 作为 DSH 用户，我希望看到最近一次错误的原文，便于自行搜索或发给维护者。
4. 作为 DSH 用户，我希望在页面上直接修复，而不是先问模型。
5. 作为 DSH 用户，我希望修复期间页面明确显示进行中，且连点不会触发两次供给。
6. 作为 headless/CLI 用户，我不希望这个浏览器面板改变插件的宿主行为。
7. 作为维护者，我希望状态面板不改变工具契约与 `status()` 的公共形状。

## Implementation Decisions

- 席位：`plugins.detail.badge` + `plugins.detail.section`，两个注册都只在 `subject.kind === 'bundle' && subject.pkg.name === 'dsh-labview-mcp'` 时渲染，其他 subject 返回 `null`。
- 数据：`GET /api/labview-mcp.status` 与 `POST /api/labview-mcp.repair`，经 `ctx.connection.fetch.register()` 注册；`connection` 用 `ctx.inject(['connection'], …)` 可选接入，headless 组合里不注册路由。
- 视图契约：`{ status, binaryPackage: { installed, root }, toolsRoot, repairing, repairError?, checkedAt }`。`repairing` 只活在路由闭包里，不进入 `LabviewService.status()`，因此工具输出 schema 不变。
- 修复语义：POST 登记 in-flight promise 后立即返回，不等待供给完成；并发点击不重复启动；请求体 `{force:true}` 与工具参数同义。
- 客户端：无构建、无 JSX，只用 `React.createElement` 与 `--dsw-alias-*` 令牌；模块级状态源，首个订阅者出现时每 2 s 轮询，订阅者归零即停；EN/ZH 文案随 `ctx.locale.register` 内联注册。
- 失败姿态：`status()` 抛错仍返回 200 + `state:'broken'`；页面取数失败只让卡片显示"状态不可用"+状态码，不抛错、不影响页面其他部分。

## Testing Decisions

- `createStatusRoutes` 是纯函数：用 stub service 覆盖视图字段、并发修复、`force` 透传、拒绝分支、非法入参。
- `client.js` 在 `node:vm` 沙箱中加载（假 `__ModuleLoader__`、假 React、假 fetch/定时器）：断言工厂 id、注册清单、subject 守卫、渲染文本、POST 目标、轮询起停。
- `smoke.test.js` 断言有/无 `connection` 时的路由注册数量，且工具集合仍是两个。
- 真实浏览器渲染无法在开发环境内验证，作为已知未验证项在交付报告中写明。

## Out of Scope

- Settings 里的 `settings.section`、`settings.plugins.tab` 页面。
- 首次启用引导卡（`plugins.bundle.activation`）、toast、插件列表卡片上的状态。
- 改工具入参/出参、增加第三个工具、自动安装二进制包、遥测。
- 引入构建步骤（保留可直接加载的 `client.js`）。
