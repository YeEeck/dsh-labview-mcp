# npm 双包分发

产品要满足“Plugins → Add plugin → dsh-labview-mcp 之后零配置可用”，但 LabVIEW MCP 的运行树约 178 MB（压缩后约 57 MB），不可能塞进一个小插件包再按平台分发。我们决定把产品拆成 `dsh-labview-mcp`（约 50 KB 的插件包）和 `dsh-labview-mcp-win32-x64`（约 57 MB 的平台二进制包，作为 `optionalDependency`），由插件在运行时解析并供给二进制。另一个方案是运行时从 GitHub 下载，但那会多一条下载、校验和信任路径，而且与插件安装依赖同一条网络通道；单包内嵌二进制则会让每个平台都下载全部平台内容，因此不采用。

## 修订（2026-11-24，1.1.0）

1.0.0 发布当天在全新 DSH 安装上复现：安装路径经过 npmmirror 时，镜像只有 `dsh-labview-mcp`，没有 57 MB 的 `dsh-labview-mcp-win32-x64@3.1.0`。pnpm 对 optional dependency 的解析失败只记 debug 日志并跳过，安装以退出码 0 结束；DSH 只在 pnpm 失败时才换 registry，因此不会回退到 npmjs。结果是插件装上、运行树缺失，状态页报 `platform binary package is not installed`。

因此把平台包从 `optionalDependency` 改为必需的 `dependency`（版本范围与二进制包保持不变），让“镜像没有平台包”变成一次可见的安装失败，而不是半安装。保留二进制包的 `os`/`cpu`，所以非 Windows 会在安装阶段被拒绝，不再出现“装上后报 unsupported”。双包结构、版本策略、版本化供给和“不从 node_modules 运行”均不变；运行时自下载和单包内嵌仍然否决。

发布脚本同时加入 registry 门禁：发布插件前确认 npmjs 与 npmmirror 都能解析该二进制版本（必要时触发镜像同步），发布后再次校验；`--skip-publish-cooldown` 需要显式设置 `DSH_RELEASE_ALLOW_EARLY_PLUGIN=1`。
