# 运行状态展示在 Plugins 插件页，而不是 Settings

状态只在两个原生工具里可见，用户必须先开会话让模型调用才能知道运行树是缺失、损坏还是冲突；而"二进制包是否解析到、运行树供给到哪一层"恰恰是安装/升级后最需要一眼看到的信息。DSH 的插件页是浏览器界面，纯 Host 插件没有向页面写数据的通道，因此我们给 bundle 加一个浏览器半边：它在 `plugins.detail.badge` 画状态标签、在 `plugins.detail.section` 画状态卡，只在自己的 bundle 页渲染（`subject.kind === 'bundle' && subject.pkg.name === 'dsh-labview-mcp'`）。

数据走 Host 自己在 `ctx.connection.fetch` 上注册的两条精确 Fetch 路由（`GET /api/labview-mcp.status`、`POST /api/labview-mcp.repair`），而不是生成的 `ctx.remote` 命名空间：后者由安装包的 `api-remotes` 在构建期固定，第三方 bundle 无法注册；精确路由则由同一张路由表分发给 Web 载体与 Desktop 的 IPC 载体，且 `connection` 以可选注入接入，headless 组合里插件照常激活、只是没有面板。

不放到 Settings：`settings.section` 是整页级的席位，`settings.plugins.tab` 是整个 Plugins 设置分区里的一页；为单个插件的运行状态各占一格，比插件自己的详情页更绕，也会与实际被管理的对象分离。`status()` 的公共契约保持不变——`repairing` 只活在路由闭包里，工具输出 schema 不受影响。
