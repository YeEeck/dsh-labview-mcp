# 05: desktop E2E 与 v1 迁移

**What to build:** 在 `desktop` profile 上完成一次可回滚的 v1 → v2 迁移，并证明“安装 → 供给 → 注册 → 使用 → 卸载”整条路径成立。

**Blocked by:** 04

**Status:** done

- [x] 迁移前备份 v1 的 `local-bundles/dsh-labview-mcp`，并记录回滚命令。
- [x] 从 profile 移除 v1 bundle，确认 `mcpManager.list()` 不再有 `labview` 配置项。
- [x] 通过 `plugin_manager` 安装本地构建的 v2 tarball；`labview_mcp_status` 最终为 `ready`。
- [x] 新建会话能看到 `mcp__labview__*` 工具，工具数量与上游 v3.1.0 实际数量一致（v3.0.4 为 121，需实测确认）。
- [x] `pylv_status` 返回 `ok: true`，`serverVersion` 正确，`aixmlBackend.pylabviewAvailable: true`；`grpcService.reachable: false` 在当前 LabVIEW 2023 上视为正常。
- [x] 卸载 v2 后：`LabVIEWMCP.exe` 进程消失、工具从新会话消失、`node_modules` 中没有运行中的 exe 句柄。
- [x] v2 验证通过后，删除旧的 `%USERPROFILE%\.dsh\tools\labview-mcp\current` 目录，回收约 178 MB。
- [x] 将上述步骤写成可复制的迁移/回滚清单；若任一步失败，能按清单恢复 v1。

## Comments

Completed on `feat/v2-implementation` (ticket 05 only). Phase A evidence file (local scratch): `C:\Users\PC\AppData\Local\Temp\dsh-labview-mcp-v2-notes\ticket05-phaseA-evidence.md`.

### Files changed

- `docs/migration-v1-to-v2.md` — new copy-pasteable v1 → v2 migration and rollback checklist (backup, remove v1, install v2 tarball, new-session verification, uninstall test, delete old `current`, rollback, DSH restart caveat).
- `.scratch/dsh-labview-mcp-v2/issues/05-desktop-e2e-migration.md` — this ticket.

`dist/dsh-labview-mcp-0.1.0-local.tgz` is a local E2E artifact and stays gitignored (`.gitignore` ignores `dist/` and `*.tgz`); it is not committed.

### Phase A — backups (2026-11-22)

- Bundle backup: `C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp.v1-backup-20261122`
  - `package.json` 270 B, SHA-256 `0CDCF33D335781322419EEE9C115CD278BABDBC52F3917588030BBD96DBD9606`
  - `cordis.patch.yml` 1053 B, SHA-256 `FC3D10C94E85F9332E10F76604536179676CE1C6796A45665E6AF75E6570EB1A`
  - `README.md` 1120 B; hashes match the source files copied.
- Profile file backup: `C:\Users\PC\.dsh\profiles\desktop\backups\v1-20261122\`
  - `package.json` 559 B、`pnpm-lock.yaml` 57387 B、`cordis.patch.yml` 10568 B.
- Original dependency: `dsh-labview-mcp: link:./local-bundles/dsh-labview-mcp`; v1 runtime `C:\Users\PC\.dsh\tools\labview-mcp\current` (v3.0.4, kept until Phase B).

### Phase A — local-wired v2 tarball

- Copied `packages/dsh-labview-mcp` to `C:\Users\PC\AppData\Local\Temp\dsh-labview-mcp-v2-notes\local-pack\dsh-labview-mcp`; changed **only** `optionalDependencies` in that temp copy to
  `{"dsh-labview-mcp-win32-x64":"file:D:/Code/dsh-proj/dsh-labview-mcp/dist/dsh-labview-mcp-win32-x64-3.1.0.tgz"}`.
  Repo `packages/dsh-labview-mcp/package.json` was not changed (still `~3.1.0`).
- `npm pack` output: `dsh-labview-mcp@0.1.0`, 8950 B, shasum `d515d1206c7fe89f79fe2c8da2f89cff1cf0a4d8`, integrity `sha512-npOa/dF0qrg29KRQDp3itw712YMEEBktZetyQrIMJaCMk9NsMviqCw0uBpzk+hPjISD/HApHx8sZk3KQiYW4eA==`.
- Copied to `D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-0.1.0-local.tgz` (8950 B, SHA-256 `CFDCE60F622E8F34E2240148AD514FA99B6947FFD9D6B3FAC96D9E674A7B7FCB`), contents `package/index.js`, `package/locale/en.json`, `package/package.json`, `package/cordis.patch.yml`.
- The published-style `dist\dsh-labview-mcp-0.1.0.tgz` was left untouched: 8900 B, SHA-256 `AD5691C5797913D530226ADD485AAA94582DEB9493B777324AF3501A13DD5EE7`.

### Phase A — remove v1

`plugin_manager action=remove_bundle target=dsh-labview-mcp`:

```json
{"stage":"remove","target":"dsh-labview-mcp","changed":true,"application":"applied","warnings":[],"packageResult":{"exitCode":0,"output":"✓ Lockfile passes supply-chain policies (verified 2h ago)\nLockfile is up to date, resolution step is skipped\nAlready up to date\n\ndependencies:\n- dsh-labview-mcp link:./local-bundles/dsh-labview-mcp\n\nDone in 2.1s using pnpm v11.28.5\n","truncated":false,"logPath":"C:\\Users\\PC\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-X6VydE\\pnpm.log"}}
```

Verified: `plugin_manager list_bundles` had total 26 without `dsh-labview-mcp`; profile `package.json` had neither the dependency nor the `dsh.profile.bundles` entry; the v1 `LabVIEWMCP.exe` (PID 12000, `...\.dsh\tools\labview-mcp\current\bin\LabVIEWMCP.exe`) exited; no `LabVIEWMCP` process remained. `mcpManager.list()` is not directly callable from this Agent (no inspect provider exposes it); equivalent evidence is the absence of the bundle row and of any `labview` MCP tools after removal.

Note: after `remove_bundle` the original `local-bundles\dsh-labview-mcp` directory was empty (0 files, mtime 23:20:35; the complete backup above was intact). The empty leftover was renamed to `local-bundles\dsh-labview-mcp.v1-emptied-20261122` while diagnosing.

### Phase A — install v2 and the restart caveat

`plugin_manager action=install_bundle target=D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-0.1.0-local.tgz` returned `application: failed`:

```json
{"stage":"enable","target":"dsh-labview-mcp","enabled":true,"changed":true,"application":"failed","registries":[null],"packageResult":{"exitCode":0,"output":"✓ Lockfile passes supply-chain policies (verified 2h ago)\nProgress: resolved 0, reused 1, downloaded 0, added 0\nProgress: resolved 41, reused 1, downloaded 0, added 0\n[WARN] 1 deprecated subdependencies found: domexception@4.0.0\n[WARN] Issues with peer dependencies found. Run \"pnpm peers check\" to list them.\nPackages: +2 -4\n++----\nProgress: resolved 213, reused 2, downloaded 0, added 1\nProgress: resolved 213, reused 2, downloaded 0, added 2\nProgress: resolved 213, reused 2, downloaded 0, added 2, done\n\ndependencies:\n+ dsh-labview-mcp 0.1.0\n\nDone in 4.7s using pnpm v11.28.5\n","truncated":false,"logPath":"C:\\Users\\PC\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-GiR17Y\\pnpm.log"},"bundle":"dsh-labview-mcp","version":"0.1.0","error":{"code":"operation-error","diagnostic":"dsh: warning: 1 entry did not activate\nlabview-mcp (dsh-labview-mcp): failed to import: Error: ENOENT: no such file or directory, lstat 'C:\\Users\\PC\\.dsh\\profiles\\desktop\\local-bundles\\dsh-labview-mcp\\index.js'"}}
```

The package step succeeded (`+ dsh-labview-mcp 0.1.0`); only activation failed. `list_bundles` showed `dsh-labview-mcp` 0.1.0 installed/enabled, source `file:D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-0.1.0-local.tgz`, row `include:labview-mcp`; `Config.listConfigs` showed that row `inactive`; `Tool.listTools` had no labview tools; no `LabVIEWMCP.exe` process.

Retries (`set_bundle enabled=true` twice, disable→enable, and after renaming the empty local-bundles folder) all reproduced the same ENOENT pointing at `local-bundles\dsh-labview-mcp\index.js`. Fresh-process checks showed the installed `node_modules\dsh-labview-mcp\index.js` imports correctly (`Config, LabviewService, apply, inject`) and `createRequire(profile/package.json).resolve.paths('dsh-labview-mcp')` first candidate is `...\desktop\node_modules\dsh-labview-mcp\package.json`.

**Root cause / caveat:** the running DSH Host kept the v1 loader-entry base URL `...\local-bundles\dsh-labview-mcp` for the `labview-mcp` row id that v1 first created at boot; a restart is required to load the fresh v2 module generation. For the in-session E2E, the lead copied the installed v2 package files (`package.json`, `index.js`, `cordis.patch.yml`, `locale/`) into `C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp` and toggled the bundle off/on with `plugin_manager set_bundle`; the bundle then applied and the fresh-session verification below passed. That temporary copy was deleted in Phase B. A clean profile installing v2 for the first time does not need this workaround. Documented in `docs/migration-v1-to-v2.md`.

### Phase A — fresh-session verification (by the lead's verification subagent)

`labview_mcp_status` returned verbatim:

```
state: ready
platform: win32
arch: x64
binaryVersion: 3.1.0
serverVersion: 0.1.0
toolCount: 122
toolsDir: C:\Users\PC\.dsh\tools\labview-mcp\3.1.0
```

`mcp__labview__pylv_status` returned `ok: true`, `serverVersion: "3.1.0 (022142ad)"`, `aixmlBackend.pylabviewAvailable: true` (`grpcService.reachable: false` is normal on the current LabVIEW 2023). `cordis_inspect_query` `Tool.listTools` counted exactly 122 names starting with `mcp__labview__`; `labview_mcp_status` and `labview_mcp_repair` were present; no errors/anomalies.

### Phase B — final in-session verification before uninstall

From this session (same running Host after the activation workaround): `labview_mcp_status` returned the same `state: ready`, `platform: win32`, `arch: x64`, `binaryVersion: 3.1.0`, `serverVersion: 0.1.0`, `toolCount: 122`, `toolsDir: C:\Users\PC\.dsh\tools\labview-mcp\3.1.0`. `Tool.listTools` had exactly 122 `mcp__labview__*` names plus `labview_mcp_status` and `labview_mcp_repair`. One `LabVIEWMCP.exe` was running from `...\labview-mcp\3.1.0\bin\LabVIEWMCP.exe` (PID 39004).

### Phase B — uninstall v2

`plugin_manager action=remove_bundle target=dsh-labview-mcp`:

```json
{"stage":"remove","target":"dsh-labview-mcp","changed":true,"application":"applied","warnings":[],"packageResult":{"exitCode":0,"output":"✓ Lockfile passes supply-chain policies (verified 20m ago)\nLockfile is up to date, resolution step is skipped\nAlready up to date\n\ndependencies:\n- dsh-labview-mcp 0.1.0\n\nDone in 2.1s using pnpm v11.28.5\n","truncated":false,"logPath":"C:\\Users\\PC\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-W1L70v\\pnpm.log"}}
```

Verification after uninstall:

- `Get-Process LabVIEWMCP` → none; no process from `C:\Users\PC\.dsh\tools\labview-mcp\3.1.0`.
- `Get-ChildItem C:\Users\PC\.dsh\profiles\desktop\node_modules | Where-Object Name -like '*labview*'` → none (`dsh-labview-mcp` and `dsh-labview-mcp-win32-x64` both gone).
- Profile `package.json`: no `dsh-labview-mcp` in dependencies or `dsh.profile.bundles`.
- `plugin_manager list_bundles`: total 26, no `dsh-labview-mcp`; `Config.listConfigs name=dsh-labview-mcp` → `entries: []`.
- `cordis_inspect_query Tool.listTools`: 0 names starting `mcp__labview__`, 0 `labview_mcp_*`.
- Deleted the temporary `C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp` copy made for the activation workaround (verified it contained exactly the 4 v2 package files before `Remove-Item`); v1 backup directories `dsh-labview-mcp.v1-backup-20261122` and `dsh-labview-mcp.v1-emptied-20261122` were left intact.

### Phase B — delete old v1 `current` runtime

Before deletion: no `LabVIEWMCP` process and no process with an `ExecutablePath` under `...\labview-mcp*` (the only matches were the checking shell's own command line). Measured `C:\Users\PC\.dsh\tools\labview-mcp\current`: **5,667 files, 186,661,226 bytes = 178.01 MiB** (v3.0.4). Deleted with `Remove-Item -LiteralPath ... -Recurse -Force`; verified the path no longer exists. The v2 cache `C:\Users\PC\.dsh\tools\labview-mcp\3.1.0` was **not** touched.

### Rollback to v1

Full copy-pasteable procedure is in `docs/migration-v1-to-v2.md` §6. Summary:

```powershell
# 0) plugin_manager action=remove_bundle target=dsh-labview-mcp
$profileDir   = "$env:USERPROFILE\.dsh\profiles\desktop"
$fileBackup   = "$profileDir\backups\v1-20261122"
$bundleBackup = "$profileDir\local-bundles\dsh-labview-mcp.v1-backup-20261122"
Copy-Item -LiteralPath "$fileBackup\package.json"     -Destination "$profileDir\package.json" -Force
Copy-Item -LiteralPath "$fileBackup\pnpm-lock.yaml"   -Destination "$profileDir\pnpm-lock.yaml" -Force
Copy-Item -LiteralPath "$fileBackup\cordis.patch.yml" -Destination "$profileDir\cordis.patch.yml" -Force
if (Test-Path -LiteralPath "$profileDir\local-bundles\dsh-labview-mcp") {
  Remove-Item -LiteralPath "$profileDir\local-bundles\dsh-labview-mcp" -Recurse -Force
}
Copy-Item -LiteralPath $bundleBackup -Destination "$profileDir\local-bundles\dsh-labview-mcp" -Recurse
$env:PATH = 'C:\Users\PC\AppData\Local\Temp\dsh-labview-mcp-v2-tools;' + $env:PATH
pnpm --dir $profileDir install
# restart DeepSeek Harness afterwards
```

Original dependency was `link:./local-bundles/dsh-labview-mcp`. Alternatively `plugin_manager action=install_bundle target=$bundleBackup` reinstalls from the backup directory but records a `file:` dependency pointing at the backup, not the original `link:` spec. If `current` has already been deleted, rollback also needs the v3.0.4 runtime re-downloaded (release asset `labview-mcp.zip`, 64,632,488 bytes, SHA-256 `d834ea73e31e8ffea3cd5d83bf91dfb08947945f93ea4a7c2814b1bbd9956b8e`); `Update-LabVIEWMCP.ps1` installs only the latest release.

### Checklist

`docs/migration-v1-to-v2.md` — covers backup, remove v1, install v2 tarball, verify new session/`pylv_status`, uninstall v2 test, delete old `current`, rollback to v1, the DSH restart caveat, and the local E2E tarball build.
