# 06: 发布脚本与 npm dry-run

**What to build:** 维护者能用一个脚本从上游 release 生成两个 npm 包，并通过 `npm pack` / `npm publish --dry-run` 检查发布内容；发布 token 只从环境变量读取。

**Blocked by:** 01, 03

**Status:** ready-for-agent

- [ ] 脚本从 GitHub API 读取最新 release，要求固定资产名 `labview-mcp.zip` 和 API 提供的 `sha256:` digest。
- [ ] 下载按 GitHub → `ghfast.top` → `gh-proxy.com` → `ghproxy.net` 顺序尝试；每个来源都按官方大小和 SHA-256 校验。
- [ ] 校验失败、缺少 digest、zip 结构不符合预期时，脚本以非零状态退出，不生成发布包。
- [ ] 脚本生成 `dsh-labview-mcp-win32-x64`（版本 = 上游 tag）和 `dsh-labview-mcp`（插件版本独立）两个 tarball，并执行 `npm pack`。
- [ ] `npm publish --dry-run` 的包内容包含运行树、`VERSION.txt`、manifest、licenses、locale、patch、icon 和文档；不包含本机缓存或临时文件。
- [ ] `NPM_TOKEN` 只从环境变量读取；脚本和仓库中没有任何 token 值。
- [ ] 用 fixture release archive 测试 checksum mismatch 被拒绝、正常 archive 生成两个 tarball、二进制 tarball 包含 `runtime/` 与 licenses。
