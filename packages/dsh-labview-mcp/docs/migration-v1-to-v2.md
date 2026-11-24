# v1 → v2 迁移与回滚清单

本清单把已在 `desktop` profile 上手工安装的 v1（本地 `link:` bundle + `%USERPROFILE%\.dsh\tools\labview-mcp\current`）迁移到 v2（可安装插件包 + 版本化供给目录）。命令可直接复制执行；`plugin_manager` 动作在 DSH Agent 会话中调用，其余为 PowerShell。

> **重要：重启注意事项**
> 在已经启动并加载过 v1 的 DSH 进程里替换同名 bundle 时，Loader 会保留 v1 的旧入口基址（`...\local-bundles\dsh-labview-mcp`），`install_bundle` 可能返回 `application: failed`，诊断形如：
> `labview-mcp (dsh-labview-mcp): failed to import: Error: ENOENT: no such file or directory, lstat '...\local-bundles\dsh-labview-mcp\index.js'`。
> 这是运行中 Host 的模块解析缓存，不是插件包的问题。**重启 DSH Desktop（Host）后重新验证即可**；全新 profile 首次安装 v2 不需要重启。不要长期手工复制包文件到 `local-bundles`；如果为了当前会话临时这样做过，验证后必须删除该副本（见第 4 步）。

## 0. 备份 v1（必做）

```powershell
$profileDir   = "$env:USERPROFILE\.dsh\profiles\desktop"
$bundleBackup = "$profileDir\local-bundles\dsh-labview-mcp.v1-backup-20261122"
$fileBackup   = "$profileDir\backups\v1-20261122"

Copy-Item -LiteralPath "$profileDir\local-bundles\dsh-labview-mcp" -Destination $bundleBackup -Recurse
New-Item -ItemType Directory -Path $fileBackup -Force | Out-Null
Copy-Item -LiteralPath "$profileDir\package.json"     -Destination $fileBackup -Force
Copy-Item -LiteralPath "$profileDir\pnpm-lock.yaml"   -Destination $fileBackup -Force
Copy-Item -LiteralPath "$profileDir\cordis.patch.yml" -Destination $fileBackup -Force

Get-FileHash "$bundleBackup\package.json","$bundleBackup\cordis.patch.yml" -Algorithm SHA256 | Format-Table
```

本次迁移使用的精确备份路径：

| 内容 | 路径 | 备注 |
|---|---|---|
| v1 bundle | `C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp.v1-backup-20261122` | `package.json` 270 B SHA-256 `0CDCF33D335781322419EEE9C115CD278BABDBC52F3917588030BBD96DBD9606`；`cordis.patch.yml` 1053 B SHA-256 `FC3D10C94E85F9332E10F76604536179676CE1C6796A45665E6AF75E6570EB1A` |
| profile 文件 | `C:\Users\PC\.dsh\profiles\desktop\backups\v1-20261122\` | `package.json` 559 B、`pnpm-lock.yaml` 57387 B、`cordis.patch.yml` 10568 B |

v1 原始依赖是 `dsh-labview-mcp: link:./local-bundles/dsh-labview-mcp`，v1 运行时是 `%USERPROFILE%\.dsh\tools\labview-mcp\current`（v3.0.4）。

## 1. 从 profile 移除 v1

Agent 会话中调用 `plugin_manager`：
- `action: remove_bundle`
- `target: dsh-labview-mcp`

核对：

```powershell
Get-Process LabVIEWMCP -ErrorAction SilentlyContinue        # 应无输出
(Get-Content "$profileDir\package.json" -Raw) -match 'dsh-labview-mcp'   # 应为 False
```

同时确认 `plugin_manager list_bundles` 不再列出 `dsh-labview-mcp`。`remove_bundle` 可能留下一个空的 `local-bundles\dsh-labview-mcp` 目录（内容已由备份保存），可重命名或删除以免干扰后续操作。

## 2. 安装 v2 tarball

Agent 会话中调用 `plugin_manager`：
- `action: install_bundle`
- `target: D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-1.0.0-local.tgz`（本地 E2E 构建；正式安装用 registry 上的 `dsh-labview-mcp`）

期望结果：`application: applied`、`bundle: dsh-labview-mcp`、`version: 1.0.0`，且 `plugin_manager list_bundles` 显示 `installed: true`、`enabled: true`。

> **内部 0.1.0 证据：** ticket 05 的完整 E2E（安装 → 供给 → 注册 → 122 工具 → 卸载）是在内部版本 `0.1.0` 上完成的。`1.0.0` 只增加展示元数据（locale、`docs/DETAIL*`、icon、licenses）并提升版本号，运行时、供给与注册逻辑未变；ticket 07 用最终 `1.0.0` 本地 tarball 复验安装和 `labview_mcp_status`。

若返回第 0 节的 ENOENT 诊断：重启 DSH Desktop（Host），再检查 `labview_mcp_status`。如果为了当前会话临时把 v2 包文件复制到了 `local-bundles\dsh-labview-mcp`，验证后必须删除该副本（第 4 步已给出命令）。

## 3. 验证 v2（新会话）

在新会话调用 `labview_mcp_status`，应返回：

```
state: ready
platform: win32
arch: x64
binaryVersion: 3.1.0
serverVersion: 0.1.0
toolCount: 122
toolsDir: C:\Users\PC\.dsh\tools\labview-mcp\3.1.0
```

再调用 `mcp__labview__pylv_status`，确认：

- `ok: true`
- `serverVersion: "3.1.0 (022142ad)"`
- `aixmlBackend.pylabviewAvailable: true`
- `grpcService.reachable: false` 在当前 LabVIEW 2023 上属正常

并确认 `mcp__labview__*` 工具数量为 122（v3.0.4 为 121，以实际版本为准），`labview_mcp_repair` 也存在：

```powershell
Get-Process LabVIEWMCP | Select-Object Id, Path
# Path 应为 C:\Users\PC\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe
```

## 4. 卸载 v2（验证安装/卸载闭环）

Agent 会话中调用 `plugin_manager`：
- `action: remove_bundle`
- `target: dsh-labview-mcp`

核对：

```powershell
Get-Process LabVIEWMCP -ErrorAction SilentlyContinue    # 应无输出
Get-ChildItem "$profileDir\node_modules" -ErrorAction SilentlyContinue |
  Where-Object Name -like '*labview*'                  # 应无输出
```

新会话（或 `cordis_inspect_query` 的 `Tool.listTools`）中不应再有 `mcp__labview__*`、`labview_mcp_status`、`labview_mcp_repair`。

删除测试期临时复制到 `local-bundles` 的 v2 包副本（仅当存在；保留所有 `.v1-backup-*`）：

```powershell
$copy = "$profileDir\local-bundles\dsh-labview-mcp"
if (Test-Path -LiteralPath $copy) {
  Get-ChildItem -LiteralPath $copy -Recurse -File | Select-Object FullName, Length
  Remove-Item -LiteralPath $copy -Recurse -Force
}
```

## 5. 删除旧 v1 运行时（仅在此后执行）

只有在 v2 已验证通过、且已完成第 4 步卸载测试后才执行。先确认没有进程占用：

```powershell
Get-Process LabVIEWMCP -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*labview-mcp*' }

$current = "$env:USERPROFILE\.dsh\tools\labview-mcp\current"
$files   = Get-ChildItem -LiteralPath $current -Recurse -File
$bytes   = ($files | Measure-Object -Property Length -Sum).Sum
"{0} files, {1} bytes, {2:N2} MiB" -f $files.Count, $bytes, ($bytes / 1MB)
Remove-Item -LiteralPath $current -Recurse -Force
```

本次实测：5,667 个文件、186,661,226 字节、178.01 MiB。不要删除 `%USERPROFILE%\.dsh\tools\labview-mcp\3.1.0`（v2 的版本化供给缓存，后续安装可复用）。

## 6. 回滚到 v1

顺序：移除 v2 → 恢复 profile 文件 → 恢复 bundle 目录 → 重建依赖 → 重启 DSH。

```powershell
# 1) 先移除 v2：plugin_manager action=remove_bundle target=dsh-labview-mcp

$profileDir   = "$env:USERPROFILE\.dsh\profiles\desktop"
$fileBackup   = "$profileDir\backups\v1-20261122"
$bundleBackup = "$profileDir\local-bundles\dsh-labview-mcp.v1-backup-20261122"

# 2) 恢复 profile 文件
Copy-Item -LiteralPath "$fileBackup\package.json"     -Destination "$profileDir\package.json" -Force
Copy-Item -LiteralPath "$fileBackup\pnpm-lock.yaml"   -Destination "$profileDir\pnpm-lock.yaml" -Force
Copy-Item -LiteralPath "$fileBackup\cordis.patch.yml" -Destination "$profileDir\cordis.patch.yml" -Force

# 3) 恢复 v1 bundle 目录（先清掉可能残留的同名空目录）
if (Test-Path -LiteralPath "$profileDir\local-bundles\dsh-labview-mcp") {
  Remove-Item -LiteralPath "$profileDir\local-bundles\dsh-labview-mcp" -Recurse -Force
}
Copy-Item -LiteralPath $bundleBackup -Destination "$profileDir\local-bundles\dsh-labview-mcp" -Recurse

# 4) 重建原始 link 依赖（恢复后的 package.json 已包含 link:./local-bundles/dsh-labview-mcp）
$env:PATH = 'C:\Users\PC\AppData\Local\Temp\dsh-labview-mcp-v2-tools;' + $env:PATH
pnpm --dir $profileDir install

# 5) 重启 DeepSeek Harness
```

也可以用 `plugin_manager action=install_bundle`，`target` 指向 `$bundleBackup`；注意这会记录一个 `file:` 依赖（指向备份目录），而不是原始的 `link:` 规范，只适合作为临时回滚。

**运行时注意事项**：如果已经执行第 5 步，`current` 已被删除，回滚还需要重新获取 v1 运行时 v3.0.4：release 资产 `labview-mcp.zip`，64,632,488 字节，SHA-256 `d834ea73e31e8ffea3cd5d83bf91dfb08947945f93ea4a7c2814b1bbd9956b8e`，解压到 `%USERPROFILE%\.dsh\tools\labview-mcp\current`。`Update-LabVIEWMCP.ps1` 只安装最新 release，不能直接锁定 v3.0.4，因此若还需要回滚能力，请在删除 `current` 前自行保留一份外部副本。

重启后检查 `plugin_manager list_bundles` 中 `dsh-labview-mcp` 为 v1 bundle（其 `package.json` 版本是 `1.0.0`），且 `LabVIEWMCP.exe` 从 `current\bin` 启动。

## 附：本地 E2E tarball 的构建方式

正式发布用 release 脚本产出的 tarball；本地离线验证可用同一份插件代码，把 `dependencies` 里的平台包指向本地二进制包：

```powershell
$tmp = "$env:TEMP\dsh-labview-mcp-local-pack\dsh-labview-mcp"
New-Item -ItemType Directory -Path $tmp -Force | Out-Null
Copy-Item -Path 'packages\dsh-labview-mcp\*' -Destination $tmp -Recurse
# 只改临时副本的 dependencies：
#   "dsh-labview-mcp-win32-x64": "file:D:/Code/dsh-proj/dsh-labview-mcp/dist/dsh-labview-mcp-win32-x64-3.1.0.tgz"
Push-Location $tmp
npm pack
Pop-Location
Move-Item "$tmp\dsh-labview-mcp-1.0.0.tgz" 'D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-1.0.0-local.tgz' -Force
```

不要修改仓库内 `packages/dsh-labview-mcp/package.json` 的 `dependencies`（它应保持 `~3.1.0`）。
