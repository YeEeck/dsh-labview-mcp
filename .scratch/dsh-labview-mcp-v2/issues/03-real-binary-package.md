# 03: 真实二进制包 v3.1.0

**What to build:** 从上游 `Zuehlke/labview-mcp` v3.1.0 的 release zip 生成可安装的 `dsh-labview-mcp-win32-x64@3.1.0` 包，并让本地插件能解析到真实的 `LabVIEWMCP.exe`。

**Blocked by:** 02

**Status:** resolved

- [x] 二进制包版本为 `3.1.0`，声明 `"os": ["win32"]` 和 `"cpu": ["x64"]`。
- [x] 包内包含完整的上游 release 运行树（`bin/LabVIEWMCP.exe`、`bin/pylabview/`、`bin/scripts/`、`bin/docs/`）、`VERSION.txt`、`labview-mcp.manifest.sha256`、`LICENSE` 和 `THIRD-PARTY-NOTICES.md`。
- [x] 包内不包含本机生成的 `.pyc` 缓存、`%USERPROFILE%\.labviewmcp` 缓存、临时文件或日志。
- [x] 本地 `npm pack` 生成的 tarball 约 57 MB，文件数量与上游 release 清单一致（预期 5,582 个文件）。
- [x] 在本地安装插件 + 二进制包后，`labview_mcp_status` 能报告 `binaryVersion: "3.1.0"`，并且 `%USERPROFILE%\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe` 存在。
- [x] `LabVIEWMCP.exe --version` 从供给目录运行并输出 3.1.0。

## Comments

Implemented on `feat/v2-implementation`.

### Review corrections (2026-11-23)

- The builder now also requires the shipped runtime directories `bin/pylabview/`, `bin/scripts/`, and `bin/docs/` (not only `bin/LabVIEWMCP.exe` and `VERSION.txt`), so a manifest-consistent zip with a stripped runtime is refused. Fixtures cover the good tree and a missing `bin/docs`.
- Status convention corrected from `done` to the tracker's `resolved` completion state.

### Files changed

- `scripts/build-binary-package.mjs` — reusable ESM builder with CLI and exported `buildBinaryPackage()` / `DEFAULT_OUT_DIRECTORY` / `DEFAULT_PACK_DESTINATION` / `DEFAULT_EXPECTED_RUNTIME_FILE_COUNT`. Verifies zip size/SHA-256 before extraction, extracts with `tar.exe -xf`, handles a single wrapping directory, copies the whole release tree to `runtime/`, writes `package.json` / `VERSION.txt` / `labview-mcp.manifest.sha256` / `LICENSE` / `THIRD-PARTY-NOTICES.md`, verifies every runtime file against the upstream manifest (5,582 files), rejects manifest/count drift and unlisted cache artifacts, stages beside the output and only then atomically replaces it, and runs `npm pack --json --pack-destination <repo>/dist`.
- `scripts/build-binary-package.test.mjs` — 8 `node:test` tests using tiny fixture zips created with `tar -a -cf`: good fixture builds a complete package with correct metadata; wrapping directory; checksum mismatch; size mismatch; manifest mismatch; unlisted local cache file; wrong runtime file count; default output path.
- `scripts/assets/LICENSE-Zuehlke.txt` — upstream Zuehlke MIT license.
- `scripts/assets/LICENSE-pylabview.txt` — pylabview MIT license (Jessica Creighton / Mefistotelis).
- `scripts/assets/THIRD-PARTY-NOTICES.md` — Zuehlke labview-mcp, pylabview, and bundled Python 3.12 (PSF) notices with the two MIT texts.
- `packages/dsh-labview-mcp/package.json` — added `optionalDependencies: { "dsh-labview-mcp-win32-x64": "~3.1.0" }`; still no dependencies/scripts/build step.
- `packages/dsh-labview-mcp/test/smoke.test.js` — relaxed the ticket-01 assertion: optionalDependencies must be exactly the platform binary range, while `dependencies`, `devDependencies`, and `scripts` remain forbidden.
- `.scratch/dsh-labview-mcp-v2/issues/03-real-binary-package.md` — this ticket.

### Commands and actual results

- `pnpm test`: `tests 26`, `pass 26`, `fail 0`, `duration_ms 1641.39` (18 existing plugin tests + 8 new builder tests).
- Real build command:

  ```
  node scripts/build-binary-package.mjs --zip .scratch/upstream/labview-mcp.zip --version 3.1.0 --out dist/dsh-labview-mcp-win32-x64 --expected-size 64961306 --expected-sha256 7d2af36081d8c2982b64de7d6b0035be59bfb1f25ccc93cb5661e9618150d2df
  ```

  Result: `ok: true`; `runtimeFileCount: 5582`; `manifestEntryCount: 5582`; `manifestListedCacheFiles: 65`; `runtimeBytes: 185477534`; `tarballPath: dist/dsh-labview-mcp-win32-x64-3.1.0.tgz`; `tarballBytes: 60323572`; `tarballEntryCount: 5587`; `tarballSha256: 455b00f22a8ec7ccfe729ef5677fe510a678965c7e3e8de46d76cade01a78746`.

  Package spot checks: `runtime/bin/LabVIEWMCP.exe` exists (89,557,041 bytes), `runtime/bin/pylabview/` exists, `runtime/bin/scripts/` exists, `runtime/bin/docs/` exists, the runtime has exactly 5,582 files, 0 `.log`/`.tmp` files and 0 `.labviewmcp` directories. The 65 `.pyc` files are the ones shipped and listed by upstream's own manifest (see caveat below).

- `npm pack` for the plugin package (in `packages/dsh-labview-mcp`, `--pack-destination <repo>/dist`): `dist/dsh-labview-mcp-0.1.0.tgz`, **5,994 bytes**, **4 entries**: `package/index.js`, `package/locale/en.json`, `package/package.json`, `package/cordis.patch.yml`; SHA-256 `6b2515fa97acf4edc3ea3ae2716e7be55841639393ca4b65015a8ed759a0f451`.
- `npm pack` for the binary package (run by the builder): `dist/dsh-labview-mcp-win32-x64-3.1.0.tgz`, **60,323,572 bytes**, **5,587 entries** = 5,582 under `package/runtime/` + `package/package.json`, `package/VERSION.txt`, `package/labview-mcp.manifest.sha256`, `package/LICENSE`, `package/THIRD-PARTY-NOTICES.md`.
- Installed both local tarballs into the scratch profile `lvtest` with pnpm 11.28.5 in `C:\Users\PC\.dsh\profiles\lvtest`:
  `pnpm add D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-0.1.0.tgz D:\Code\dsh-proj\dsh-labview-mcp\dist\dsh-labview-mcp-win32-x64-3.1.0.tgz`. The profile `package.json` now lists both `file:` dependencies and `dsh.profile.bundles` still lists `dsh-labview-mcp`. (`dsh plugin --profile lvtest add ...` produced no output/exit in this shell, so the documented pnpm fallback was used.)
- `createRequire` from the installed plugin resolves the binary package:

  ```
  C:\Users\PC\.dsh\profiles\lvtest\node_modules\dsh-labview-mcp-win32-x64\package.json
  ```

- Node exercise against the installed plugin (`binaryPackageRoot` = the installed binary package root, `toolsRoot = C:\Users\PC\.dsh\tools\labview-mcp`, `platform: 'win32'`, `arch: 'x64'`):

  ```
  status before: {"state":"missing","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"C:\\Users\\PC\\.dsh\\tools\\labview-mcp\\3.1.0"}
  ensure:        {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"C:\\Users\\PC\\.dsh\\tools\\labview-mcp\\3.1.0"}
  status after:  {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"C:\\Users\\PC\\.dsh\\tools\\labview-mcp\\3.1.0"}
  plugin status: {"state":"ready","platform":"win32","arch":"x64","binaryVersion":"3.1.0","toolsDir":"C:\\Users\\PC\\.dsh\\tools\\labview-mcp\\3.1.0"}
  tools: ["labview_mcp_status","labview_mcp_repair"]
  ```

  The plugin's `apply()` + `labview_mcp_status` tool (fake ctx) therefore reports `binaryVersion: "3.1.0"`.

- Provisioned runtime: `C:\Users\PC\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe` exists (5,583 files in the provisioned version directory = 5,582 runtime files + the package-root manifest copy). `...\bin\LabVIEWMCP.exe --version` prints:

  ```
  LabVIEW MCP 3.1.0 (022142ad)
    version        3.1.0
    commit         022142ad0c55f92dd6dea6d76b6a3e135ba32511
    exe            C:\Users\PC\.dsh\tools\labview-mcp\3.1.0\bin\LabVIEWMCP.exe
    archive        C:\Users\PC\.dsh\tools\labview-mcp\3.1.0\VERSION.txt
  ```

- `.staging-*` after successful `ensure()`: **0** directories under `C:\Users\PC\.dsh\tools\labview-mcp` (only `3.1.0` and the untouched v1 `current`). The build staging directory under `dist/` is also gone.

### Caveats

- The upstream v3.1.0 zip itself ships **65 `.pyc` files under `__pycache__`** and the upstream `labview-mcp.manifest.sha256` lists all of them. Rejecting every `.pyc`/`__pycache__` unconditionally would make the required 5,582-file build impossible, so the builder rejects cache-like files/directories that are **not listed in the verified manifest** (local `__pycache__`, `.pyc`, `.log`, `.tmp`, `.labviewmcp`, `.DS_Store`, `Thumbs.db`). A clean real build passes with 5,582 files and reports `manifestListedCacheFiles: 65`.
- `expectedFileCount` defaults to `5582` so the documented v3.1.0 build fails on any drift. Ticket 06's future-release path must pass the upstream manifest's line count for other tags.
- `dist/` tarballs and the extracted upstream tree remain gitignored and are not committed.
