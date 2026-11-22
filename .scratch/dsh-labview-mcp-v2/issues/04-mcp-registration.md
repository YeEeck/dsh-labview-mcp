# 04: MCP 注册与生命周期

**What to build:** 供给成功后，插件自动把 LabVIEW MCP 注册到 DSH，用户在新会话看到 `mcp__labview__*` 工具；`labview_mcp_status` 能报告连接与工具数量，`labview_mcp_repair` 能重启注册。

**Blocked by:** 03

**Status:** resolved

- [x] 只有 `LabviewService.status().state === 'ready'` 后才调用 `ctx.mcpManager.register('labview', entry)`。
- [x] 注册项为 stdio：command 指向供给目录的 `LabVIEWMCP.exe`，cwd 指向其 `bin` 目录，`toolCallTimeoutMs` 来自插件 Config（默认 300000）。
- [x] `labview_mcp_status` 在 ready 时返回 `serverVersion`、`toolCount`、`toolsDir`、`binaryVersion`；新会话出现 `mcp__labview__*` 工具。
- [x] `labview_mcp_repair` 能 dispose 旧注册并重新注册；重复调用是幂等的，不产生重复进程。
- [x] 如果 `mcpManager.list()` 中已存在非本插件注册的 `labview`，状态为 `conflict`，不注册，并给出可操作错误。
- [x] 插件卸载/禁用时，`ctx.effect` 的 disposer 移除 MCP 注册，`LabVIEWMCP.exe` 进程退出。
- [x] 在 DSH 0.2.2-rc.5 的 new session 中验证 `pylv_status`（或 `mcp__labview__pylv_status`）返回 `ok: true`，`serverVersion` 为 3.1.0。

## Comments

Implemented on `feat/v2-implementation` (ticket 04 only).

### Review corrections (2026-11-23)

- Registration failures are persisted: a generic `register()` throw, a conflict, or a server-list read failure makes a later `status()` return `broken`/`conflict` with `lastError` instead of `ready` without `serverVersion`/`toolCount`.
- A `connecting`/`reconnecting` live status is reported as `provisioning`; `ready` requires `connected` plus a numeric `toolCount` and a probed `serverVersion`. A connection wait that times out returns `broken`.
- Status convention corrected from `done` to the tracker's `resolved` completion state.

### Files changed

- `packages/dsh-labview-mcp/index.js` — `inject = ['tools', 'mcpManager']`; exported hand-rolled Standard Schema V1 `Config` exposing only `toolCallTimeoutMs` (default `300000`, positive-finite validation); `LabviewService` now takes `registrar`, `toolCallTimeoutMs`, `mcpStartupTimeoutMs`, and `registrationCloseTimeoutMs`; registers `labview` once after provisioning reaches `ready` with `{ transport: 'stdio', command: <versionDir>\bin\LabVIEWMCP.exe, cwd: <versionDir>\bin, toolCallTimeoutMs, startupTimeoutMs: 120000 }`; reports `serverVersion`/`toolCount`/`toolsDir`/`binaryVersion`; detects foreign `labview` rows as `conflict`; caches the probe result; `repair()` disposes + waits for withdrawal + re-registers; `dispose()` removes the registration and never resurrects it; `apply()` passes `ctx.mcpManager` and config through.
- `packages/dsh-labview-mcp/test/mcp-registration.test.js` — new 11-test suite with a fake registrar covering exact registration entry, idempotent ensure, conflict, repair, dispose, unsupported/missing/broken, failed/disappeared registrations, and `Config` validation.
- `packages/dsh-labview-mcp/test/smoke.test.js` — fake Host context now supplies `mcpManager` (`list`/`register`/`probe`) so the new injection is satisfied.
- `.scratch/dsh-labview-mcp-v2/issues/04-mcp-registration.md` — this ticket.

### Commands and actual results

- `node --test` (repo root): `tests 37`, `pass 37`, `fail 0`, `duration_ms 3222.1253` (26 pre-existing + 11 new).
- `npm pack --pack-destination D:\Code\dsh-proj\dsh-labview-mcp\dist` (in `packages/dsh-labview-mcp`): `dsh-labview-mcp-0.1.0.tgz`, 8,900 bytes, 4 files (`index.js` 32.0 kB unpacked), SHA-256 `ad5691c5797913d530226add485aaa94582deb9493b777324af3501a13dd5ee7`.
- Installed into the scratch profile:
  ```
  cd C:\Users\PC\.dsh\profiles\lvtest
  pnpm add D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-0.1.0.tgz
  # -> Already up to date (pnpm kept the old 0.1.0 file: tarball)
  # forced reload of the same version:
  Remove-Item node_modules\dsh-labview-mcp -Recurse -Force
  pnpm install --force
  ```
  Result: `node_modules\dsh-labview-mcp\index.js` is 31,961 bytes (new build). `dsh.profile.bundles` still contains `dsh-labview-mcp`.
- Live headless session (key read from `C:\Users\PC\.dsh\.credentials.yaml` refs and exported only for the process). The actual launcher wrapper is:
  ```powershell
  $env:DEEPSEEK_API_KEY = '<value of refs.DEEPSEEK_API_KEY>'
  $env:ELECTRON_RUN_AS_NODE='1'
  $bin='C:\Users\PC\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js'
  $p = Start-Process -FilePath 'C:\Users\PC\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe' `
    -ArgumentList @("`"$bin`"", '--profile', 'lvtest', "`"Call pylv_status and report ok, serverVersion, and aixmlBackend.pylabviewAvailable exactly.`"") `
    -Wait -PassThru -NoNewWindow -RedirectStandardOutput dist\ticket04-final-live.out.txt -RedirectStandardError dist\ticket04-final-live.err.txt
  ```
  (`Start-Process -Wait` is required because PowerShell's `&` does not wait for the GUI-subsystem Electron process; a plain `dsh --profile lvtest "..."` from an installed CLI is the same boot.)
  `EXIT=0`; stdout verbatim excerpt:
  ```
  | `ok` | `true` |
  | `serverVersion` | `"3.1.0 (022142ad)"` |
  | `aixmlBackend.pylabviewAvailable` | `true` |
  ```
- Second live headless session (same launcher wrapper, prompt changed):
  ```
  dsh --profile lvtest "Call labview_mcp_status and report state, binaryVersion, serverVersion, toolCount, and toolsDir exactly."
  ```
  `EXIT=0`; the model's second call (after the first caught the background registration still in progress) reported:
  ```
  state: ready
  binaryVersion: 3.1.0
  serverVersion: 0.1.0
  toolCount: 122
  toolsDir: C:\Users\PC\.dsh\tools\labview-mcp\3.1.0
  ```
- After both sessions: no `LabVIEWMCP.exe` process from `C:\Users\PC\.dsh\tools\labview-mcp\3.1.0`; only the pre-existing v1 `C:\Users\PC\.dsh\tools\labview-mcp\current\bin\LabVIEWMCP.exe` (PID 12000, started 2026-11-19) remains, which this ticket did not touch.

### Caveats

- `labview_mcp_status.serverVersion` is `registrar.probe('labview').serverInfo.version`, which the v3.1.0 server reports as `0.1.0` (its MCP server assembly version). The `pylv_status` tool itself reports the upstream release version `3.1.0 (022142ad)`. This follows the ticket's specified source for `serverVersion`.
- `dsh --profile lvtest --dump-config-schema` reports `status: "unsupported"` / `Config is not a native Schemastery schema` for the hand-rolled Standard Schema V1 `Config`. Config resolution and headless boot work (`--dump-config` shows the row; live sessions exit 0); the package must stay dependency-free, so the hand-rolled schema is intentional.
- A fresh headless session can call a tool before the background registration finishes; the first `labview_mcp_status` may see `state: provisioning`/no `serverVersion`/`toolCount`. Retrying the status (or `labview_mcp_repair`) resolves it, as anticipated by the ticket. Registration itself is exactly once per process; no duplicate `LabVIEWMCP.exe` processes were observed.
- `pnpm add` skips re-extracting a changed tarball when the version string is unchanged; the forced `pnpm install --force` path above is required when testing a rebuilt `0.1.0` tarball.
