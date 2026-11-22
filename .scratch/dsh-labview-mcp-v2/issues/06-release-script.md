# 06: 发布脚本与 npm dry-run

**What to build:** 维护者能用一个脚本从上游 release 生成两个 npm 包，并通过 `npm pack` / `npm publish --dry-run` 检查发布内容；发布 token 只从环境变量读取。

**Blocked by:** 01, 03

**Status:** done

- [x] 脚本从 GitHub API 读取最新 release，要求固定资产名 `labview-mcp.zip` 和 API 提供的 `sha256:` digest。
- [x] 下载按 GitHub → `ghfast.top` → `gh-proxy.com` → `ghproxy.net` 顺序尝试；每个来源都按官方大小和 SHA-256 校验。
- [x] 校验失败、缺少 digest、zip 结构不符合预期时，脚本以非零状态退出，不生成发布包。
- [x] 脚本生成 `dsh-labview-mcp-win32-x64`（版本 = 上游 tag）和 `dsh-labview-mcp`（插件版本独立）两个 tarball，并执行 `npm pack`。
- [x] `npm publish --dry-run` 的包内容包含运行树、`VERSION.txt`、manifest、licenses、locale、patch（icon 与 docs 由 ticket 07 补齐；本 ticket 的 dry-run 检查不以其缺失为失败条件）；不包含本机缓存或临时文件。
- [x] `NPM_TOKEN` 只从环境变量读取；脚本和仓库中没有任何 token 值。
- [x] 用 fixture release archive 测试 checksum mismatch 被拒绝、正常 archive 生成两个 tarball、二进制 tarball 包含 `runtime/` 与 licenses。

## Comments

Implemented on `feat/v2-implementation`.

### Files changed

- `scripts/release.mjs` — maintainer release script with an exported API (`runRelease`, `fetchLatestRelease`, `parseReleaseMetadata`, `downloadVerifiedAsset`, `DEFAULT_MIRRORS`) and a CLI. It validates the GitHub release JSON (`tag_name` → `3.1.0`, exact `labview-mcp.zip` and `labview-mcp.manifest.sha256` assets, `sha256:` digest, size), verifies both assets through the mirror order GitHub → `ghfast.top` → `gh-proxy.com` → `ghproxy.net` (per-source timeouts: 10 min zip / 2 min manifest, configurable), derives `expectedFileCount` from the manifest line count, calls `buildBinaryPackage()` with `manifestPath` / `expectedSha256` / `expectedSize` / `expectedFileCount`, packs the plugin package at its own `package.json` version, runs `npm publish --dry-run --json` for both package directories, asserts the required file lists (both tarball and publish report), and writes `dist/release-report.json` with full file lists. Actual publishing is opt-in via `--publish binary` / `--publish plugin`; `NPM_TOKEN` is only read from the environment and passed to npm through a temporary `.npmrc` containing `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` outside the repo — never in metadata, logs, or a command line. All building happens in `<out>/.release-staging-*`, promoted only after every check passes, so checksum/manifest/structure failures leave no package tarballs behind.
- `scripts/release.test.mjs` — 10 `node:test` tests using tiny fixture zips made with `tar -a -cf` and fixture release JSON: good fixture produces both tarballs and the binary tarball/package contains `runtime/bin/LabVIEWMCP.exe`, `VERSION.txt`, `labview-mcp.manifest.sha256`, `LICENSE`, `THIRD-PARTY-NOTICES.md`; checksum mismatch rejects (API and CLI exit 1) with no tarballs; missing digest; zip without `bin/LabVIEWMCP.exe`; publish mode without `NPM_TOKEN` fails before building; malformed JSON; bad tag; missing fixed asset; mirror fallback skips a bad candidate/timeout and reports the working mirror; all-checksum-mismatch rejection.
- `.scratch/dsh-labview-mcp-v2/issues/06-release-script.md` — this ticket.
- `.scratch/upstream/release-v3.1.0.json` — gitignored offline fixture built from the verified v3.1.0 API values, used for the real offline build.

### Commands and actual results

- `pnpm test`: `tests 47`, `pass 47`, `fail 0`, `duration_ms 15382.2652`. The release test file prints its fixture tarballs: `dsh-labview-mcp-win32-x64-3.1.0.tgz (2447 bytes)`, `dsh-labview-mcp-0.1.0.tgz (8900 bytes)`.
- Live GitHub API resolution (`fetchLatestRelease({ timeoutMs: 60000 })`):
  `tag: v3.1.0`, `version: 3.1.0`, `zip: labview-mcp.zip`, `zipSize: 64961306`, `zipDigest: sha256:7d2af36081d8c2982b64de7d6b0035be59bfb1f25ccc93cb5661e9618150d2df`, `manifest: labview-mcp.manifest.sha256`, `manifestSize: 738474`, `manifestDigest: sha256:e04fff337af86e412db46de6651c0cd2fd8be772ae5bb8008f766995aa3088f6`.
- Live mirror check for the manifest asset (`downloadVerifiedAsset` with defaults): succeeded from `ghfast.top` (GitHub direct did not complete), **738,474 bytes**, SHA-256 `e04fff337af86e412db46de6651c0cd2fd8be772ae5bb8008f766995aa3088f6`.
- Real offline release build (no re-download of the upstream zip):
  ```
  node scripts/release.mjs --release-json .scratch/upstream/release-v3.1.0.json --archive .scratch/upstream/labview-mcp.zip --manifest .scratch/upstream/manifest.sha256 --out dist
  ```
  Exit 0, elapsed **134.56 s**. Result: `downloads.zip.source: local` (64,961,306 bytes, SHA-256 `7d2af360...d2df`); `downloads.manifest.source: local` (738,474 bytes, SHA-256 `e04fff...88f6`); `expectedFileCount: 5582`; binary `runtimeFileCount: 5582`; binary tarball `dist\dsh-labview-mcp-win32-x64-3.1.0.tgz` = **60,323,572 bytes**, SHA-256 `455b00f22a8ec7ccfe729ef5677fe510a678965c7e3e8de46d76cade01a78746`; plugin tarball `dist\dsh-labview-mcp-0.1.0.tgz` = **8,900 bytes**, SHA-256 `ad5691c5797913d530226add485aaa94582deb9493b777324af3501a13dd5ee7`; report `dist\release-report.json` (910,676 bytes). No `.release-staging-*` left behind.
- `npm publish --dry-run --json` run directly on both real package directories (captured to `.scratch/upstream/dryrun-binary.json` / `dryrun-plugin.json`):
  - `dsh-labview-mcp-win32-x64@3.1.0`: **5,587 entries**, **60,323,572 bytes**, unpacked **186,221,261 bytes**. Key entries: `runtime/bin/LabVIEWMCP.exe` (89,557,041 bytes), `VERSION.txt` (173), `labview-mcp.manifest.sha256` (738,474), `LICENSE` (1,064), `THIRD-PARTY-NOTICES.md` (3,638).
  - `dsh-labview-mcp@0.1.0`: **4 entries**, **8,900 bytes**, unpacked **32,659 bytes**: `index.js` (31,961), `cordis.patch.yml` (77), `locale/en.json` (141), `package.json` (480).
  - No publish was performed.

### Caveats

- Actual `npm publish` was not exercised (ticket scope says do not publish). The `--publish` path is limited to the `NPM_TOKEN`-missing rejection test; the registry publish itself and its `--json` response shape remain unverified until a real release.
- The real zip was not re-downloaded (it is the verified local archive); the live mirror path was exercised on the 738 KB manifest only.
- `icon` / `docs` are intentionally absent from the plugin package until ticket 07; the release script does not fail on them. Ticket 07 must add them and repeat this final dry-run.
- `dist/` and `.scratch/upstream/` are gitignored; the rebuilt binary package and report stay local.
