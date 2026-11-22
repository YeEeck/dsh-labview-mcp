# 07: 公开文档与展示元数据

**What to build:** 用户安装前能看懂这是什么、有什么代价；安装后能看到完整的插件卡片、详情页和双语说明。

**Blocked by:** 05, 06

**Status:** resolved

- [x] 插件标题为 `LabVIEW MCP (unofficial)`；描述明确说明是 Zuehlke LabVIEW MCP 的非官方 DSH bundle。
- [x] `locale/en.json` 和 `locale/zh.json` 覆盖 `meta.title`、`meta.description`、`meta.detail`，英文使用 sentence case。
- [x] 详情页第一屏写明：非官方、Windows x64、首次下载约 57 MB、约 65–75k tokens/请求、如何在 Plugins 页禁用。
- [x] 图标为原创图形，不使用 NI 或 Zuehlke 的商标/logo，满足 32×32 / 文件格式限制。
- [x] 包含 `LICENSE`（本项目 MIT）、`LICENSE-Zuehlke.txt`（上游 MIT）、`LICENSE-pylabview.txt`、`THIRD-PARTY-NOTICES.md`，并在 README 中说明来源与许可证。
- [x] README 覆盖安装、配置（`toolCallTimeoutMs`）、故障排查（missing/broken/conflict/unsupported）、v1 迁移与回滚、发布流程。
- [x] `package.json` 的 `files` 覆盖入口、patch、locale、详情文档、icon 和许可证；本地安装与实际 `npm pack` 文件清单一致。
- [x] 通过实际安装检查 Plugins 卡片、详情页、英文和中文文案；无法用浏览器验证的部分在交付报告中明确标注。

## Comments

Implemented on `feat/v2-implementation` (ticket 07 only).

### Review corrections (2026-11-23)

- The Plugins card, detail page, preview rendering, and live English/Chinese locale switching could **not** be visually inspected: no browser control was available and client inspect timed out. The checklist item is supported only by file/package-level evidence (locale JSON, SVG validation, packed file lists), not by a rendered view.
- `icon.svg` uses a 36×36 `viewBox` per DSH's artwork guide and renders at the 32×32 icon row size; the ticket's "32×32" wording was imprecise.
- The full v1 → v2 migration checklist now ships inside the package as `docs/migration-v1-to-v2.md`; the README links it relatively. Final `npm pack --dry-run` / `npm publish --dry-run` report **15 entries**, 20,181 bytes packed, 64,675 bytes unpacked.
- Status convention corrected from `done` to the tracker's `resolved` completion state.

### Files changed

- `packages/dsh-labview-mcp/package.json` — version `1.0.0`; added `./icon` export and `docs`, `icon.svg`, `README.md`, all four license/notice files to `files`. No `dependencies`, no `scripts`, no build step; `optionalDependencies` stays `dsh-labview-mcp-win32-x64: ~3.1.0`.
- `packages/dsh-labview-mcp/locale/en.json` — title `LabVIEW MCP (unofficial)`; sentence-case description covering unofficial status, ~57 MB first download, 122 tools, 65–75k tokens/request, Windows x64, disabling in Plugins, and the native diagnostics; `meta.detail: docs/DETAIL.md`.
- `packages/dsh-labview-mcp/locale/zh.json` — same title; Chinese description with all the same facts; `meta.detail: docs/DETAIL.zh.md`.
- `packages/dsh-labview-mcp/docs/DETAIL.md`, `docs/DETAIL.zh.md` — exactly one image line each with meaningful alt text, pointing at `preview.svg`.
- `packages/dsh-labview-mcp/docs/preview.svg` — text-free, self-contained 640×300 (`viewBox="0 0 640 300"`) illustration: plugin package → provisioned local runtime → tool grid; no text/scripts/styles/foreignObject/external resources and no NI/Zuehlke marks.
- `packages/dsh-labview-mcp/icon.svg` — original 36×36 (`viewBox="0 0 36 36"`) plug-plus-waveform mark, transparent background, single restrained blue, no text/scripts/styles/images/foreignObject or NI/Zuehlke marks.
- `packages/dsh-labview-mcp/README.md` — what it is (unofficial), install via Plugins → Add plugin → `dsh-labview-mcp`, requirements (Windows x64; LabVIEW optional: `pylv_*` without LabVIEW, `lvai_*` needs LabVIEW's AI gRPC), first download ~57 MB / 122 tools / ~65–75k tokens per request, `toolCallTimeoutMs` (default `300000`), status/repair tools, troubleshooting table for `missing`/`provisioning`/`ready`/`broken`/`conflict`/`unsupported`, disable/uninstall, v1 migration + rollback link to `docs/migration-v1-to-v2.md`, release process (binary version = upstream tag, plugin version independent, 24 h cooldown, `NPM_TOKEN` env), source/license attribution.
- `packages/dsh-labview-mcp/LICENSE` — project MIT (`Copyright (c) 2026 dsh-labview-mcp contributors`).
- `packages/dsh-labview-mcp/LICENSE-Zuehlke.txt`, `LICENSE-pylabview.txt` — copied byte-for-byte from `scripts/assets/` (upstream MIT and pylabview MIT).
- `packages/dsh-labview-mcp/THIRD-PARTY-NOTICES.md` — adapted for the plugin package: Zuehlke labview-mcp MIT, pylabview MIT, Python 3.12 PSF; states the binary package ships the complete upstream runtime tree under `runtime/`.
- `packages/dsh-labview-mcp/test/metadata.test.js` — new tests for version/dependency invariants, `files` coverage, both locales, one-line detail docs, 640×300 preview / 36×36 icon constraints, and license/notice presence.
- `scripts/release.mjs` — plugin dry-run assertions now require `icon.svg`, `README.md`, the license/notice files, and both detail docs + preview (not just entry/patch/locale).
- `scripts/release.test.mjs` — fixture assertions updated to plugin `1.0.0` and the new required plugin files.
- `docs/migration-v1-to-v2.md` — local E2E tarball name/version updated to `dsh-labview-mcp-1.0.0-local.tgz` / `1.0.0`; note added that ticket 05's full E2E evidence was captured on internal `0.1.0`; rollback wording disambiguated because the v1 bundle also has package version `1.0.0`.
- `.scratch/dsh-labview-mcp-v2/issues/07-public-docs-and-metadata.md` — this ticket.

`dist/dsh-labview-mcp-1.0.0.tgz`, `dist/dsh-labview-mcp-1.0.0-local.tgz` and `dist/release-report.json` are gitignored build artifacts and not committed.

### Tests

`node --test` (repo root, Node 24.21.0):

```
tests 55
pass 55
fail 0
duration_ms 12079.5504
```

Includes the 8 new metadata tests. Full log: `C:\Users\PC\AppData\Local\Temp\dsh-labview-mcp-v2-notes\ticket07-node-test-final.log`.

### `npm pack` / `npm publish --dry-run` — final plugin package 1.0.0

Commands (in `packages/dsh-labview-mcp`):

```
npm pack --json --pack-destination <temp>
npm publish --dry-run --json
```

Both report **14 entries**, 15,573 bytes packed, 52,391 bytes unpacked; tarball SHA-256 `730d63590bf26bb0bdf2f2f8f73051be91b8b8a52a9eb1b6a3a9275d427f1136`:

```
LICENSE                 1085
LICENSE-pylabview.txt   1159
LICENSE-Zuehlke.txt     1064
README.md               7001
THIRD-PARTY-NOTICES.md  4038
cordis.patch.yml          77
docs/DETAIL.md           155
docs/DETAIL.zh.md        164
docs/preview.svg        3413
icon.svg                 501
index.js               31961
locale/en.json           534
locale/zh.json           585
package.json             654
```

This is exactly the intended file set (README and package.json are always included by npm); no tests, no scratch files, no binary payload.

### `npm pack` / `npm publish --dry-run` — final binary package 3.1.0

Commands (in `dist/dsh-labview-mcp-win32-x64`):

```
npm pack --json --pack-destination <temp>
npm publish --dry-run --json
```

Both report **5,587 entries**, 60,323,572 bytes packed, 186,221,261 bytes unpacked. Non-`runtime/` entries:

```
LICENSE                 1064
THIRD-PARTY-NOTICES.md  3638
VERSION.txt              173
labview-mcp.manifest.sha256  738474
package.json             378
runtime/                 5582 entries
```

### Release report

Re-ran the full offline release build after the docs/icon/licences were in place (do not publish):

```
node scripts/release.mjs --release-json .scratch/upstream/release-v3.1.0.json --archive .scratch/upstream/labview-mcp.zip --manifest .scratch/upstream/manifest.sha256 --out dist
```

Exit 0; `dist/release-report.json` written at `2026-11-22T15:53:12` with `expectedFileCount: 5582`; binary `dsh-labview-mcp-win32-x64@3.1.0` = 60,323,572 bytes, SHA-256 `455b00f22a8ec7ccfe729ef5677fe510a678965c7e3e8de46d76cade01a78746`; plugin `dsh-labview-mcp@1.0.0` = 15,573 bytes, SHA-256 `730d63590bf26bb0bdf2f2f8f73051be91b8b8a52a9eb1b6a3a9275d427f1136`; both dry-run file lists verified by the script's new required-entry assertions. No publish was performed.

### Actual install check in `desktop`

Local-wired tarball built from a temp copy of `packages/dsh-labview-mcp`; **only** the temp copy's `optionalDependencies` was changed to
`{"dsh-labview-mcp-win32-x64":"file:D:/Code/dsh-proj/dsh-labview-mcp/dist/dsh-labview-mcp-win32-x64-3.1.0.tgz"}`. The committed `package.json` was not modified (still `~3.1.0`). `npm pack` output: `dsh-labview-mcp-1.0.0.tgz`, 15,603 bytes, 14 entries, moved to `dist/dsh-labview-mcp-1.0.0-local.tgz` (SHA-256 `9696774AB1F91A34C790B3EEC8BA403F500E8B0C72BDC4ABB02AC8F25DDD594E`).

`plugin_manager action=install_bundle target=D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-1.0.0-local.tgz`:

- pnpm package step succeeded: `+ dsh-labview-mcp 1.0.0`, exit 0.
- Activation initially returned `application: failed` with the documented stale-loader error: `labview-mcp (dsh-labview-mcp): failed to import: Error: ENOENT ... open 'C:\Users\PC\.dsh\profiles\desktop\local-bundles\dsh-labview-mcp\index.js'`. This is the long-running Host retaining the v1 loader base, as documented in `docs/migration-v1-to-v2.md`; a fresh profile does not need the workaround.
- Used only the documented temporary local-bundles copy workaround: copied the installed package's 14 files to `...\local-bundles\dsh-labview-mcp`, toggled `set_bundle` off/on; both responses `application: applied`. The copy was deleted after verification; only `dsh-labview-mcp.v1-backup-20261122` and `dsh-labview-mcp.v1-emptied-20261122` remain in `local-bundles`.
- After cleanup: `plugin_manager list_plugins` shows `include:labview-mcp`, `moduleName: dsh-labview-mcp`, `enabled: true`, `fiberPhase: active`, `patchId: labview-mcp`; `LabVIEWMCP.exe` (PID 42216) runs from `C:\Users\PC\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe`.

`plugin_manager list_bundles` shows the bundle: `dsh-labview-mcp`, official `false`, availability `profile`, `version: 1.0.0`, `description: "Unofficial DSH bundle for Zuehlke's LabVIEW MCP server"`, `source: "file:D:\\Code\\dsh-proj\\dsh-labview-mcp\\dist\\dsh-labview-mcp-1.0.0-local.tgz"`, `enabled: true`, `installed: true`, `removable: true`, row `labview-mcp`.

Installed package directory `C:\Users\PC\.dsh\profiles\desktop\node_modules\dsh-labview-mcp` contains all 14 files from the list above; SHA-256 comparison against `packages/dsh-labview-mcp` matches for every file except `package.json`, whose only difference is the temp copy's `file:` optionalDependency (version remains `1.0.0`). The optional binary package `dsh-labview-mcp-win32-x64@3.1.0` is installed with `os: ["win32"]`, `cpu: ["x64"]`.

### Fresh-session verification (via lead's verification subagent)

`labview_mcp_status` verbatim:

```
state: ready
platform: win32
arch: x64
binaryVersion: 3.1.0
serverVersion: 0.1.0
toolCount: 122
toolsDir: C:\Users\PC\.dsh\tools\labview-mcp\3.1.0
```

`mcp__labview__pylv_status`: `ok: true`, `serverVersion: "3.1.0 (022142ad)"`, `serverCommit: 022142ad...`, `pylabviewCommit: 69768647...`, Python 3.12 x64, `aixmlBackend.pylabviewAvailable: true`, `grpcService.reachable: false` (normal on this LabVIEW 2023 installation), `exportCache.state: warm` (853/853), `labviewHealth.looksDegraded: false`.

`cordis_inspect_query Tool.listTools`: 180 total tools; exactly 122 tools whose names start with `mcp__labview__` (122 unique); `labview_mcp_status` and `labview_mcp_repair` present; no duplicates, errors, or retries. A repeat inspect after the final cleanup again counted 122 `mcp__labview__` tools plus the two native diagnostics.

### Browser / Plugins-page verification caveat

No browser control is available from this shell. Client inspect (`cordis_inspect_query` platform `client`, `Service.listService`) timed out after 10,000 ms with "Open or reconnect the Harness page, then retry", so the rendered Plugins card, the detail page's preview image, light/dark appearance, and live English/Chinese copy switching remain **visually unverified**. What is verified: `locale/en.json` and `locale/zh.json` contain the required `meta.title`/`meta.description`/`meta.detail`; both declared detail documents exist and each is one image line; `docs/preview.svg` and `icon.svg` are valid, dimension-correct, text-free self-contained SVGs; all of these files are inside the packed and installed package; and `plugin_manager list_bundles` reports the bundle version/description/source. Also note the current Host was activated through the stale-loader workaround, so a restart is needed for it to load the package from `node_modules` directly (the profile dependency and bundle entry already point at the installed 1.0.0 package).
