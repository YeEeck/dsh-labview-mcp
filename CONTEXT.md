# dsh-labview-mcp

一个把 Zuehlke 的 LabVIEW MCP 服务器接入 DSH 的插件产品：用户只需从 Plugins 安装插件，不需要手工安装 MCP 或编辑 profile 配置。

## Language

**插件包 (plugin package)**:
用户在 DSH Plugins 里按名字安装的那个 npm 包，携带 bundle manifest 与负责供给、注册的 Host 插件。
_Avoid_: plugin bundle、npm 插件

**二进制包 (binary package)**:
随插件包一起安装的平台特定 npm 包，包含 LabVIEW MCP 的运行树。
_Avoid_: server 包、exe 包

**供给 (provision)**:
把运行树从已安装的二进制包复制到用户的工具目录，使服务器不从 `node_modules` 里运行。
_Avoid_: 安装、下载（当实际动作是复制时）

**注册 (register)**:
在插件运行时通过 DSH 的 MCP manager 挂载 LabVIEW MCP 服务器；它不是 profile `cordis.patch.yml` 里的一行配置。
_Avoid_: 配置、安装

**Host 模式**:
插件的默认暴露方式：MCP 服务器的工具对 profile 内所有会话可见。
_Avoid_: 全局模式、常驻模式

**状态工具 (status tool)**:
原生工具 `labview_mcp_status`：只读报告运行树是缺失、供给中、就绪、损坏还是被同名 MCP 服务器阻塞。
_Avoid_: 健康检查、doctor

**修复工具 (repair tool)**:
原生工具 `labview_mcp_repair`：重新执行供给并重启 MCP 注册。
_Avoid_: 安装器、fixer

**供给目录 (tools directory)**:
用户 `.dsh\tools\labview-mcp` 下按版本划分的目录，运行树被复制到这里。
_Avoid_: 安装目录、缓存目录

**一键安装 (one-click install)**:
产品验收条件：在 Plugins → Add plugin 输入 `dsh-labview-mcp` 后，不再需要任何手工步骤即可在新会话获得 LabVIEW 工具。
_Avoid_: 自动安装（含义过宽）
