# Spec: dsh-labview-mcp v2

## Problem Statement

目前 DSH 用户要使用 LabVIEW MCP，必须手工从 GitHub 下载约 178 MB 的 Windows 运行树，放到固定目录，再在 profile 的 `cordis.patch.yml` 里写一行 `@deepseek-ai/dsh-mcp-client`。现有 v1 只是一个本地 `link:` bundle，解决了单机配置，但陌生人无法在 Plugins 里一键安装；版本升级、迁移和 `serverName: labview` 冲突都靠手工处理。

结果是：安装不可发现、步骤多、容易失败，而且用户无法从插件市场获得一个“装上就能用”的 LabVIEW MCP。

## Solution

发布两个 npm 包：

- `dsh-labview-mcp`：约 50 KB 的 DSH 插件包，包含 bundle manifest、Host 插件、状态工具和中文/英文展示资源。
- `dsh-labview-mcp-win32-x64`：约 57 MB 的平台二进制包，作为插件包的**必需依赖**（1.1.0 起；1.0.0 为 `optionalDependency`），包含完整的 LabVIEW MCP 运行树和许可证。

用户在 **Plugins → Add plugin** 输入 `dsh-labview-mcp` 后，插件在 Host 启动时后台把运行树供给到版本化目录，注册 `labview` MCP server，并暴露 `labview_mcp_status` / `labview_mcp_repair`。新会话中会出现 `mcp__labview__*` 工具，不需要手工下载或编辑 profile。

## User Stories

1. As a DSH user, I want to install the plugin by typing `dsh-labview-mcp` in Plugins, so that I do not need to know npm, pnpm, or YAML.
2. As a DSH user, I want the plugin to install the platform binary automatically, so that I do not download a 178 MB zip manually.
3. As a DSH user, I want the runtime to be copied outside `node_modules`, so that a pnpm upgrade does not delete a running executable.
4. As a DSH user, I want provisioning to start in the background, so that DSH does not freeze while 178 MB is copied.
5. As a DSH user, I want `labview_mcp_status` to show whether the runtime is missing, provisioning, ready, broken, or conflicted, so that I know what is happening.
6. As a DSH user, I want `labview_mcp_repair` to retry provisioning, so that a transient failure does not force a full reinstall.
7. As a DSH user, I want `labview_mcp_repair` with `force` to recopy a corrupted runtime, so that I can recover without deleting files by hand.
8. As a DSH user, I want the MCP server to be registered only after provisioning succeeds, so that I never get tools pointing at a missing executable.
9. As a DSH user, I want the server name to be `labview`, so that tools always appear as `mcp__labview__*`.
10. As a DSH user, I want the status tool to report the binary version, so that I know which upstream release I am running.
11. As a DSH user, I want the status tool to report the MCP server version and tool count, so that I can verify the connection.
12. As a DSH user, I want a clear status when the binary package is missing, so that I know to reinstall the plugin.
13. As a DSH user on macOS or Linux, I want a clear `unsupported platform` status, so that I do not wonder why nothing works.
14. As a DSH user with an existing `labview` MCP server, I want a clear `conflict` status, so that I know to remove the other server first.
15. As a DSH user, I want the plugin to not crash the Host when provisioning or registration fails, so that my other sessions keep working.
16. As a DSH user, I want the plugin to work after a DSH restart, so that I do not reconfigure every time.
17. As a DSH user, I want the plugin to recover or restart the server after a transient crash, so that tools come back without a reinstall.
18. As a DSH user, I want an adjustable tool timeout, so that long LabVIEW operations do not fail at the 60-second default.
19. As a DSH user, I want to disable the plugin in Plugins, so that the 121 tools disappear from new sessions without uninstalling.
20. As a DSH user, I want the plugin card to say “LabVIEW MCP (unofficial)”, so that I know it is not an NI or Zuehlke official product.
21. As a Chinese-speaking user, I want a Chinese locale, so that I understand the plugin description and limitations.
22. As a user evaluating the plugin, I want the detail page to state the 65–75k token cost, Windows x64 requirement, and ~57 MB download, so that I can decide before installing.
23. As a DSH user, I want the plugin to keep two previous runtime versions, so that I can roll back manually if an upgrade breaks.
24. As a DSH user, I want the plugin to never touch my old v1 `tools\labview-mcp\current` directory, so that my old setup keeps working during trial.
25. As a user migrating from v1, I want a documented backup, remove, install, and rollback sequence, so that I can switch safely.
26. As a user, I want the old v1 `current` directory removed after v2 verification, so that I recover 178 MB.
27. As a DSH user, I want uninstalling the plugin to dispose the MCP registration and stop the server process, so that nothing lingers.
28. As a DSH user, I want no install scripts or build approvals, so that Add plugin really is one click.
29. As a DSH user, I want the plugin to preserve my other DSH plugins and profile settings, so that installation is isolated.
30. As a DSH user, I want the plugin to be idempotent if installed or repaired twice, so that no duplicate processes or copies are created.
31. As a DSH user, I want the MCP tools to be available to subagents, so that delegated LabVIEW work uses the same server.
32. As a DSH user, I want `pylv_status` to work without LabVIEW installed, so that I can verify the bundled Python engine.
33. As a DSH user, I want `lvai_*` tools to work when LabVIEW’s AI gRPC service is available, so that I can automate LabVIEW.
34. As a maintainer, I want one release script that downloads, verifies, packs, and publishes both packages, so that releases are repeatable.
35. As a maintainer, I want the binary package version to equal the upstream tag and the plugin version to be independent, so that I know what to release.
36. As a maintainer, I want unit tests for provisioning states and paths, so that I can refactor safely.
37. As a maintainer, I want an end-to-end acceptance checklist, so that I can prove the one-click promise.
38. As a maintainer, I want MIT licensing and third-party notices, so that redistribution is compliant.
39. As a maintainer, I want a 24-hour release cooldown plan, so that pnpm’s `minimumReleaseAge` does not make the first day uninstallable.
40. As a maintainer, I want no automatic npm publish on upstream releases, so that I can review upstream churn first.

## Implementation Decisions

### Distribution and versions

- Two public npm packages under the `yeeeck` account: `dsh-labview-mcp` and `dsh-labview-mcp-win32-x64`.
- Binary package version equals the upstream release tag (first release `3.1.0`). Plugin version is independent: `0.1.0` for internal testing, `1.0.0` for the public release.
- The plugin declares `dsh-labview-mcp-win32-x64` as a required `dependency` with range `~3.1.0` (changed from `optionalDependency` in 1.1.0 after a mirror-lag incident; see ADR 0001 revision). A future upstream minor or major release requires a plugin version bump; upstream patch releases within the same range do not.
- The binary package declares `"os": ["win32"]` and `"cpu": ["x64"]`; other platforms are refused at install time. `state: unsupported` remains only for direct/local installs.
- The binary package contains the full upstream release tree under `runtime/`, plus `VERSION.txt`, `labview-mcp.manifest.sha256`, `LICENSE`, and `THIRD-PARTY-NOTICES.md`. It is not a curated subset.

### Plugin package

- The plugin package is a DSH Host-only bundle with `dsh.bundle.patch` inserting one Host row.
- It has no runtime `dependencies`, no install scripts, and no build step; all plugin code is plain ESM in one entry module.
- `apply(ctx, config)` injects `mcpManager` and `tools`, creates one `LabviewService`, registers the two native tools synchronously, and starts provisioning in the background through `ctx.effect`.
- The plugin row config schema exposes only `toolCallTimeoutMs` (default `300000`). `serverName` is fixed to `labview`; `toolsDir` is not configurable in v1.

### LabviewService contract

The service is the single test seam. It is constructed with injected `binaryPackageRoot`, `toolsRoot`, `registrar`, `platform`, and `arch`; production wiring supplies the real values derived from the installed binary package and DSH.

```ts
type LabviewState =
  | 'unsupported'
  | 'missing'
  | 'provisioning'
  | 'ready'
  | 'broken'
  | 'conflict'

interface LabviewStatus {
  state: LabviewState
  platform: string
  arch: string
  binaryVersion?: string
  serverVersion?: string
  toolCount?: number
  toolsDir?: string
  lastError?: string
}

interface LabviewService {
  status(): Promise<LabviewStatus>
  ensure(): Promise<LabviewStatus>
  repair(options?: { force?: boolean }): Promise<LabviewStatus>
  dispose(): Promise<void>
}
```

### Provisioning rules

- Resolve the binary package from the plugin package with `createRequire(import.meta.url).resolve('dsh-labview-mcp-win32-x64/package.json')`. A resolution failure produces `state: 'missing'`.
- Copy the runtime tree to `%USERPROFILE%\.dsh\tools\labview-mcp\<binaryVersion>\`.
- Write into a sibling `.staging-<guid>` directory first, then rename atomically to the version directory. A partial stage is never treated as ready.
- Keep the two most recent version directories. Never delete a version directory whose executable is currently running.
- Do not use a `current` junction or symlink. Do not run the executable from `node_modules`.
- After copy, verify the runtime against `labview-mcp.manifest.sha256` when present. A mismatch produces `state: 'broken'` with `lastError`.
- The v1 `tools\labview-mcp\current` directory is never touched by the plugin. It is deleted by the documented migration step only after v2 has been verified.

### Native tools

- `labview_mcp_status`: read-only, no arguments, returns the `LabviewStatus` fields in a stable readable text form.
- `labview_mcp_repair`: optional `{ force?: boolean }`; default `false`. It re-runs provisioning when the runtime is missing or broken, restarts the MCP registration, and returns the same status shape.
- Both tools are registered even when the platform is unsupported or the binary package is missing, so the user always has a diagnostic surface.
- Tool descriptions must state that they are the first place to look when `mcp__labview__*` tools are absent or failing.

### MCP registration

- Register with `ctx.mcpManager.register('labview', entry)` only after provisioning is `ready`.
- The entry is `transport: 'stdio'`, `command` pointing at the provisioned `LabVIEWMCP.exe`, `cwd` set to its `bin` directory, `toolCallTimeoutMs` from config, and the manager’s default reconnect policy.
- Keep the returned disposer and call it from the plugin’s `ctx.effect` cleanup; no custom uninstall hook is needed.
- Before registering, call `mcpManager.list()`: if a `labview` server is already configured or registered by something else, report `state: 'conflict'` and do not register.
- If the server later fails or is removed, `labview_mcp_repair` must dispose any existing registration and call `register` again.

### Release pipeline

- `scripts/release.mjs` reads the latest upstream release from the GitHub API, requires the fixed asset name `labview-mcp.zip` and an API-provided `sha256:` digest, downloads through the mirror order GitHub → `ghfast.top` → `gh-proxy.com` → `ghproxy.net`, and verifies size and SHA-256 before extraction.
- The script builds the binary package from the extracted release tree, writes package metadata and version `3.1.0`, and runs `npm pack` for both packages.
- Publishing reads `NPM_TOKEN` from the environment only; the token is never written to the repository or package metadata.
- Release order: publish the binary package `3.1.0` first; after 24 hours publish the plugin. The public announcement is held until the plugin version is at least 24 hours old, so pnpm’s default `minimumReleaseAge` of 1440 minutes does not make the install fail.
- Registry gate: before publishing the plugin, verify the exact binary version on npmjs and npmmirror (requesting a mirror sync first) and fail when either is stale; verify the new tarball on both registries after each publish. `--skip-publish-cooldown` additionally requires `DSH_RELEASE_ALLOW_EARLY_PLUGIN=1`.
- Upstream follow-up is manual: a maintainer reviews the upstream changelog before running the script. No automatic publishing on upstream releases.

### Display and legal

- Plugin title: `LabVIEW MCP (unofficial)`.
- Description: an unofficial DSH bundle for Zuehlke’s LabVIEW MCP server; it installs the runtime and registers the 121 tools.
- Locales: English and Simplified Chinese, both covering the same metadata.
- Detail document first screen: unofficial status, Windows x64 requirement, first download size (~57 MB), token cost (~65–75k tokens per request), how to disable the plugin.
- Original icon only; no NI or Zuehlke trademarks or logos.
- Our packages are MIT. Include the upstream MIT license, the pylabview MIT license and copyright notice, and a `THIRD-PARTY-NOTICES.md`.

### v1 migration

- Back up the existing v1 local bundle before touching it.
- Remove the v1 bundle from the profile, install the v2 local tarball, and verify in a new session: `pylv_status` is `ok: true`, `serverVersion` is correct, and the expected `mcp__labview__*` tools are present.
- After v2 verification, delete the old `%USERPROFILE%\.dsh\tools\labview-mcp\current` directory.
- Document the rollback path: restore the v1 bundle and keep the old runtime until v2 is accepted.

## Testing Decisions

- **Single primary seam: `LabviewService`.** Tests construct the service with a temporary `toolsRoot`, a fixture `binaryPackageRoot`, a fake `registrar` that records calls, and explicit `platform`/`arch`. This is the highest practical seam: above it is the real DSH process, which is verified by the manual acceptance checklist rather than unit tests.
- Tests must assert external behavior: returned `LabviewStatus`, files present or absent under `toolsRoot`, registrar calls, and cleanup. They must not assert internal helper calls or private fields.
- Required cases:
  - Fresh installation: `missing` → `ensure()` → `ready`; staging directory gone; version directory present; registrar called once.
  - Idempotence: a second `ensure()` does not recopy or re-register.
  - Corrupted or partial stage: next `ensure()` recovers; `repair({ force: true })` recopies.
  - Unsupported platform: `unsupported`, no copy, no registrar call.
  - Missing binary package: `missing`, clear `lastError`, no crash.
  - Name conflict: `conflict`, no registrar call.
  - Version retention: three versions leave the two newest.
  - Manifest mismatch: `broken`, no registration.
- **Secondary tooling seam: release script.** Test the release script with a fixture release archive and manifest: checksum mismatch refuses, good archive produces both package tarballs, and the binary tarball file list includes the runtime tree and licenses.
- **Manual acceptance checklist** (not a code seam):
  - Fresh local tarball install in a DSH profile.
  - New session lists the expected `mcp__labview__*` tools.
  - `pylv_status` returns `ok: true`, the expected `serverVersion`, and `aixmlBackend.pylabviewAvailable: true`.
  - Uninstall: the `LabVIEWMCP.exe` process disappears and no executable handle remains in `node_modules`.
  - The old v1 `current` directory is deleted only after the v2 check passes.
- Prior art: this is a greenfield repo, so there is no existing test pattern. Use Node’s built-in `node:test` runner and plain `assert`; no test dependency is added to the plugin package.

## Out of Scope

- `scope: 'preset'` or any agent-preset exposure mode; v1 is Host-only.
- macOS and Linux binary packages.
- A GitHub runtime download fallback.
- Automatic updates of the binary while the plugin is installed.
- Automatic removal of the v1 bundle or its `current` directory by the plugin.
- Custom `serverName`, custom `toolsDir`, or a generic MCP-server configuration surface.
- A native rewrite of the 121 LabVIEW MCP tools.
- Telemetry, analytics, or usage reporting.
- CI-based npm publishing or provenance; the first release uses the local release script.
- Real-LabVIEW `lvai_*` integration tests (the AI gRPC service is not available on the current LabVIEW installation).
- Localization beyond English and Simplified Chinese.

## Further Notes

- Upstream `Zuehlke/labview-mcp` v3.1.0 was published on 2026-11-21; the release zip is 64,961,306 bytes with SHA-256 `7d2af36081d8c2982b64de7d6b0035be59bfb1f25ccc93cb5661e9618150d2df`. The installed v3.0.4 tree is 177.89 MiB / 5,663 files; the upstream zip has 5,582 files / 176.88 MiB.
- `LabVIEWMCP.exe` locates `pylabview` via `LABVIEWMCP_PYLABVIEW`, then `<exe dir>\pylabview`, then up to 8 parent directories. The runtime tree layout must preserve `bin\LabVIEWMCP.exe` and `bin\pylabview\`.
- `pylv_*` tools do not require LabVIEW or a system Python. `lvai_*` tools require LabVIEW’s `lvai.LVAI` gRPC service.
- The executable is unsigned. Windows SmartScreen or antivirus scanning may delay the first launch; the status tool should surface a startup timeout rather than leaving the user with a silent failure.
- The plugin is installed with pnpm 11.28.5 in a profile with `nodeLinker: hoisted`. DSH’s `install_bundle` does not override `minimumReleaseAge`; the release sequence above accounts for that.
- The 121-tool / 65–75k-token figure comes from v3.0.4; confirm the tool count with `pylv_status`/`labview_mcp_status` after building v3.1.0. If the count changes, update the plugin description and detail page rather than assuming 121 forever.
- Upstream release cadence is high (8 releases across 5 days in November 2026). If the upstream `bin/` layout or `VERSION.txt` shape changes, the release script must fail loudly rather than publish a broken binary package.
