# dsh-labview-mcp

An **unofficial** DSH bundle for [Zuehlke's LabVIEW MCP server](https://github.com/Zuehlke/labview-mcp).
It installs the LabVIEW MCP runtime for Windows x64 and registers it as the MCP
server `labview`, so new DSH sessions get `mcp__labview__*` tools without any
manual download or profile editing. This project is not affiliated with or
endorsed by NI or Zuehlke.

## What you get

- **122 LabVIEW MCP tools** in every new session, named `mcp__labview__*`.
- **Two native diagnostics**: `labview_mcp_status` and `labview_mcp_repair`.
- **Versioned local runtime**: the plugin copies the runtime to
  `%USERPROFILE%\.dsh\tools\labview-mcp\<binary-version>\` and keeps the two
  newest versions. It never runs the executable from `node_modules`.
- **No install scripts, no build step, no runtime dependencies** in the plugin
  package.

## Requirements

- **Windows x64**. Other platforms install the plugin but report
  `state: unsupported`; no binary package exists for them.
- **LabVIEW is optional.** The `pylv_*` tools use the bundled pylabview engine
  and work without LabVIEW installed. The `lvai_*` tools need LabVIEW's AI gRPC
  service (`lvai.LVAI`) to be available.
- **Cost**: adding the plugin downloads the ~57 MB platform package
  `dsh-labview-mcp-win32-x64`; first use copies about 178 MB of runtime files to
  the tools directory in the background. The 122 tools cost roughly
  **65–75k tokens per request**, because every tool definition is sent to the
  model.

## Install

1. Open **Plugins** in DSH.
2. Choose **Add plugin**.
3. Enter `dsh-labview-mcp` and confirm.

The Host downloads the optional Windows x64 runtime package during
installation. On first start, the plugin provisions the runtime in the
background and registers the `labview` MCP server after provisioning succeeds.
A new session then sees the `mcp__labview__*` tools.

The first launch of the unsigned `LabVIEWMCP.exe` can be slow while Windows
scans it; the plugin gives the server up to 120 seconds to start.

## Configuration

The only configurable option is the per-tool-call timeout, `toolCallTimeoutMs`,
in milliseconds. The default is `300000` (5 minutes). To change it, override the
`labview-mcp` row's config in the profile's
`%USERPROFILE%\.dsh\profiles\<profile>\cordis.patch.yml`:

```yaml
- id: labview-mcp
  config:
    toolCallTimeoutMs: 600000
```

Restart DSH after changing the config. The MCP server name (`labview`) and the
tools directory are fixed.

## Diagnostics and troubleshooting

`labview_mcp_status` is read-only and reports the current state.
`labview_mcp_repair` retries provisioning, restarts the MCP registration, and
returns the same status; pass `{ "force": true }` to recopy an intact but
suspected-bad runtime. Both tools are registered even when the platform is
unsupported or the binary package is missing, and they are the first place to
look when `mcp__labview__*` tools are absent or failing.

| State | Meaning | What to do |
|---|---|---|
| `missing` | The optional `dsh-labview-mcp-win32-x64` package cannot be resolved, or the runtime has not been provisioned yet. | Wait if provisioning is in progress; otherwise reinstall the plugin or run `labview_mcp_repair`. |
| `provisioning` | The runtime is being copied in the background. | Wait; then call `labview_mcp_status` again. |
| `ready` | The runtime exists and the server connection is healthy. | No action. `toolCount` should be 122. |
| `broken` | The runtime is incomplete, corrupt, or the MCP server failed/closed. | Run `labview_mcp_repair`; use `force: true` if the runtime looks intact but is corrupt. |
| `conflict` | Another `labview` MCP server is already configured or registered (for example the old v1 bundle). | Remove that server, then run `labview_mcp_repair`. |
| `unsupported` | The platform is not Windows x64. | Use a Windows x64 machine; there is no binary package for this platform. |

## Disable and uninstall

- To stop paying the token cost without uninstalling, disable **LabVIEW MCP
  (unofficial)** in **Plugins**. The tools disappear from new sessions; existing
  sessions keep what they already loaded.
- To remove it completely, uninstall the plugin in **Plugins**. The MCP
  registration is disposed and the server process stops. The provisioned
  runtime under `%USERPROFILE%\.dsh\tools\labview-mcp\<version>\` is left on
  disk so a later reinstall can reuse it; delete that directory manually if you
  want the disk space back.

## Migrating from v1

The v1 local bundle cannot coexist with v2 because both register the MCP server
name `labview`. The full backup, remove, install, verify, uninstall, and
rollback procedure is in
[v1 → v2 migration and rollback](../../docs/migration-v1-to-v2.md) (in the
project repository). In short: back up the v1 bundle, remove it with Plugins,
install `dsh-labview-mcp` 1.0.0, verify `labview_mcp_status` reports `ready`
with 122 tools in a new session, then delete the old
`%USERPROFILE%\.dsh\tools\labview-mcp\current` directory. Keep the v1 backup
until v2 is accepted so you can roll back.

## Release process

The repository ships one maintainer script, `scripts/release.mjs`, for both npm
packages:

- The binary package `dsh-labview-mcp-win32-x64` has the **upstream release
  version** (currently `3.1.0`). The plugin package `dsh-labview-mcp` has its
  **own independent version** (currently `1.0.0`) and declares the binary
  package as `optionalDependencies: { "dsh-labview-mcp-win32-x64": "~3.1.0" }`.
  An upstream minor or major release needs a plugin version bump; patch
  releases inside `~3.1.0` do not.
- The script reads the latest GitHub release, requires the fixed asset
  `labview-mcp.zip` and its `sha256:` digest, downloads through the mirror order
  GitHub → `ghfast.top` → `gh-proxy.com` → `ghproxy.net`, and verifies size and
  SHA-256 before extraction. It then builds both packages and runs
  `npm publish --dry-run` file-list checks.
- Release order: publish the binary package first, wait **24 hours**, then
  publish the plugin. Hold the public announcement until the plugin version is
  at least 24 hours old, so pnpm's default `minimumReleaseAge` of 1440 minutes
  does not make the first-day install fail.
- Publishing reads `NPM_TOKEN` from the environment only. The token is never
  written to the repository or package metadata.
- Upstream releases are reviewed manually; there is no automatic publish.

## Source and licenses

- This project is MIT-licensed: see [LICENSE](LICENSE).
- The upstream Zuehlke **labview-mcp** runtime is MIT-licensed:
  [LICENSE-Zuehlke.txt](LICENSE-Zuehlke.txt).
- The bundled **pylabview** engine is MIT-licensed:
  [LICENSE-pylabview.txt](LICENSE-pylabview.txt).
- The binary package ships a bundled **Python 3.12** interpreter under the PSF
  License.
- The full third-party attribution is in
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The binary package
  `dsh-labview-mcp-win32-x64` ships the complete upstream runtime tree.
