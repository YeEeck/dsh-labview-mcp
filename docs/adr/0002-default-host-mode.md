# 默认 Host 模式

v3.0.4 的工具面是 121 个工具、约 65–75k tokens/请求；如果默认只在 preset 中暴露，用户安装后还要选择 preset，违背“一键安装”的验收条件。我们决定 v1 默认 Host 模式，并接受每个会话都携带这笔 token 成本；用户可以在 Plugins 页禁用整个插件来退出。`scope: 'preset'` 留到后续版本，届时做成独立的 `labview` Agent preset，而不是改写用户已有 preset。
