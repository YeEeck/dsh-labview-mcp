# 02: 版本化供给核心

**What to build:** `labview_mcp_status` 从一个 fixture 二进制包读取运行树，把它复制到版本化工具目录，并正确报告 `missing` / `provisioning` / `ready` / `broken` / `unsupported` 状态；此阶段不注册 MCP。

**Blocked by:** 01

**Status:** done

- [x] `LabviewService` 提供 `status()` / `ensure()` / `repair()` / `dispose()`，可由测试注入 `toolsRoot`、`binaryPackageRoot`、`platform` 和 `arch`。
- [x] 供给先写 `.staging-<guid>`，成功后再原子 rename 为 `<binaryVersion>/`；半成品不会被报告为 `ready`。
- [x] 同一版本重复 `ensure()` 不重复复制；保留最近两个版本目录；不会删除正在运行的版本。
- [x] `status` 覆盖 `missing`、`provisioning`、`ready`、`broken`、`unsupported`；`repair({ force: true })` 可强制重新复制。
- [x] 单元测试使用临时目录和 fixture 二进制包，覆盖 fresh install、幂等、partial stage 恢复、三个版本的保留、unsupported、missing binary、manifest 不匹配。
- [x] 单元测试只断言外部行为（返回状态、文件存在/不存在、目录数量），不断言内部私有函数。

## Comments

Implemented on `feat/v2-implementation`.

### Files changed

- `packages/dsh-labview-mcp/index.js` — added the exported `LabviewService` class (`status` / `ensure` / `repair` / `dispose`) with injected `binaryPackageRoot`, `toolsRoot`, `registrar`, `platform`, `arch`, and `homeDir`; versioned provisioning into `toolsRoot/<binaryVersion>`, `.staging-<guid>` staging + manifest verification + atomic rename, single-flight `ensure()`, cheap readiness checks, force repair, retention of the two newest version directories, and `apply()` production wiring (`createRequire` resolution, background `ensure()` through `ctx.effect`, real status/repair tools).
- `packages/dsh-labview-mcp/test/labview-service.test.js` — 10 new `node:test` tests with temp dirs and fixture binary packages.
- `packages/dsh-labview-mcp/test/smoke.test.js` — added `settledStatus()` so the status test waits out the transient `provisioning` state that `apply()` now starts in the background; all original assertions retained.
- `.scratch/dsh-labview-mcp-v2/issues/02-provisioning-core.md` — this ticket file.

### Commands and actual results

- `pnpm test` (pnpm 11.28.5 shim): `tests 18`, `pass 18`, `fail 0`, `duration_ms 845.2506`. 10 service tests + 8 smoke tests all green.
- Manual Node snippet against a fixture package (temp dirs), printing the status transitions:

  ```
  status before ensure: {"state":"missing","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"...\\tools\\3.1.0"}
  ensure:               {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"...\\tools\\3.1.0"}
  status after ensure:  {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"...\\tools\\3.1.0"}
  toolsRoot entries: [ '3.1.0' ]
  staging remains: false
  provisioned exe: fixture executable 3.1.0
  force repair:         {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"...\\tools\\3.1.0"}
  ```

- No `.staging-*` after a successful `ensure()`: confirmed by the manual snippet (`staging remains: false`) and by the fresh-install / recovery / concurrent tests, which assert the same on the live `toolsRoot`.
- Additional install check: `pnpm pack` and `dsh plugin --profile lvtest add <tarball>` installed the new build; `dsh --profile lvtest "Reply with exactly: ok"` exited 1 only with `MISSING_CREDENTIAL: llm-deepseek` and the baseline `mcp-manager ... pending (waiting for service: credentials)`. No `labview-mcp` activation/schema error, so the new output schema is accepted by the tool registry.

### Caveats

- `serverVersion` / `toolCount` are intentionally not populated in this ticket; they belong to MCP registration (ticket 04). The status schema already declares them.
- `dispose()` is a no-op and `registrar` is stored but unused, by design; ticket 04 owns registration and the disposer.
- The Windows file-lock branch ("deletion of a busy version directory fails") is implemented as a tolerant `catch`, but a real exclusive executable lock cannot be deterministically simulated with temp files; it remains covered by code inspection only.
- No real 57 MB binary package exists yet (ticket 03); all provisioning tests use fixture packages under `os.tmpdir()`.
- `apply()` starts provisioning in the background. In tests a status call issued in the same tick can therefore observe `provisioning` before the service settles to `missing`/`ready`; the smoke test deliberately polls for the settled state.
