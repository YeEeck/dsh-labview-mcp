# 版本化供给，不从 node_modules 运行

LabVIEWMCP.exe 在 Windows 上会锁定自己的可执行文件，而 pnpm 升级或卸载 `node_modules` 时会删除正在运行的文件。我们决定把运行树复制到 `%USERPROFILE%\.dsh\tools\labview-mcp\<version>\`：先写 `.staging-<guid>`，再原子 rename；保留最近两个版本，不删除正在运行的版本。插件不直接运行 `node_modules` 里的 exe，也不使用 `current` 链接；旧 v1 的 `current` 目录在 v2 验证通过后由迁移步骤手工删除。
