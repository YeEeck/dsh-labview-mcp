# npm 双包分发

产品要满足“Plugins → Add plugin → dsh-labview-mcp 之后零配置可用”，但 LabVIEW MCP 的运行树约 178 MB（压缩后约 57 MB），不可能塞进一个小插件包再按平台分发。我们决定把产品拆成 `dsh-labview-mcp`（约 50 KB 的插件包）和 `dsh-labview-mcp-win32-x64`（约 57 MB 的平台二进制包，作为 `optionalDependency`），由插件在运行时解析并供给二进制。另一个方案是运行时从 GitHub 下载，但那会多一条下载、校验和信任路径，而且与插件安装依赖同一条网络通道；单包内嵌二进制则会让每个平台都下载全部平台内容，因此不采用。
