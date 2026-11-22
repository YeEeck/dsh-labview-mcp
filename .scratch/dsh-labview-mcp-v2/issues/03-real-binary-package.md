# 03: 真实二进制包 v3.1.0

**What to build:** 从上游 `Zuehlke/labview-mcp` v3.1.0 的 release zip 生成可安装的 `dsh-labview-mcp-win32-x64@3.1.0` 包，并让本地插件能解析到真实的 `LabVIEWMCP.exe`。

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] 二进制包版本为 `3.1.0`，声明 `"os": ["win32"]` 和 `"cpu": ["x64"]`。
- [ ] 包内包含完整的上游 release 运行树（`bin/LabVIEWMCP.exe`、`bin/pylabview/`、`bin/scripts/`、`bin/docs/`）、`VERSION.txt`、`labview-mcp.manifest.sha256`、`LICENSE` 和 `THIRD-PARTY-NOTICES.md`。
- [ ] 包内不包含本机生成的 `.pyc` 缓存、`%USERPROFILE%\.labviewmcp` 缓存、临时文件或日志。
- [ ] 本地 `npm pack` 生成的 tarball 约 57 MB，文件数量与上游 release 清单一致（预期 5,582 个文件）。
- [ ] 在本地安装插件 + 二进制包后，`labview_mcp_status` 能报告 `binaryVersion: "3.1.0"`，并且 `%USERPROFILE%\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe` 存在。
- [ ] `LabVIEWMCP.exe --version` 从供给目录运行并输出 3.1.0。
