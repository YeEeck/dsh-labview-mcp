/**
 * Host plugin for the dsh-labview-mcp bundle.
 *
 * `LabviewService` is the single test seam for the product. Production wiring
 * resolves the optional platform binary package and supplies a versioned tools
 * root under the user's DSH directory. This ticket implements provisioning
 * only; MCP registration is added by a later ticket.
 */

import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

export const inject = ['tools']

const STATES = ['unsupported', 'missing', 'provisioning', 'ready', 'broken', 'conflict']

const SUPPORTED_PLATFORM = 'win32'
const SUPPORTED_ARCH = 'x64'

const STAGING_PREFIX = '.staging-'
const EXECUTABLE_RELATIVE_PATH = path.join('bin', 'LabVIEWMCP.exe')
const VERSION_DIR_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/

const STATUS_DESCRIPTION =
  'Read-only diagnostic for the LabVIEW MCP runtime. This is the first place to look when '
  + '`mcp__labview__*` tools are absent or failing: it reports whether the runtime is missing, '
  + 'provisioning, ready, broken, unsupported, or blocked by a conflicting `labview` server.'

const REPAIR_DESCRIPTION =
  'Repair the LabVIEW MCP runtime by re-running provisioning and restarting the MCP server '
  + 'when the runtime is missing or broken. This is the first place to look when '
  + '`mcp__labview__*` tools are absent or failing; it returns the same status report as '
  + '`labview_mcp_status`.'

/** Convert an unknown thrown value into a readable message. */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** True on the only platform for which a binary package exists. */
function isSupportedPlatform(platform, arch) {
  return platform === SUPPORTED_PLATFORM && arch === SUPPORTED_ARCH
}

/** `stat` without throwing for a missing path. */
async function pathExists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** True when `targetPath` is a regular file. */
async function isFile(targetPath) {
  try {
    return (await stat(targetPath)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** Copy a file when it exists; an absent optional file is not an error. */
async function copyIfExists(sourcePath, destinationPath) {
  try {
    await copyFile(sourcePath, destinationPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

/** Parse a directory name as a semantic version, or return null. */
function parseVersionDirectory(name) {
  const match = VERSION_DIR_PATTERN.exec(name)
  if (!match) return null
  return {
    name,
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    suffix: match[4] ?? '',
  }
}

/** Newest semantic version first; a release sorts above its prerelease. */
function compareVersionDirectories(a, b) {
  if (a.major !== b.major) return b.major - a.major
  if (a.minor !== b.minor) return b.minor - a.minor
  if (a.patch !== b.patch) return b.patch - a.patch
  if (a.suffix === b.suffix) return 0
  if (a.suffix === '') return -1
  if (b.suffix === '') return 1
  return a.suffix < b.suffix ? -1 : 1
}

/** Compare two paths without being case-sensitive on Windows. */
function samePath(a, b) {
  const left = path.resolve(a)
  const right = path.resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Verify every manifest entry against the staged runtime.
 *
 * Format: `<64-hex sha256><two spaces><relative path>`, paths relative to the
 * release/runtime root (the staging directory itself). A missing manifest is
 * allowed; a malformed manifest, a missing file or a checksum mismatch throws.
 */
async function verifyStageAgainstManifest(stageRoot, manifestPath) {
  let manifestText
  try {
    manifestText = await readFile(manifestPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }

  const lines = manifestText.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue

    const match = /^([0-9a-fA-F]{64}) {2}(.+)$/.exec(line)
    if (!match) {
      throw new Error(`manifest line ${index + 1} is malformed: ${line.slice(0, 120)}`)
    }

    const expectedHash = match[1].toLowerCase()
    const relativePath = match[2].trim()
    const normalizedPath = path.normalize(relativePath)
    if (!relativePath || path.isAbsolute(normalizedPath) || normalizedPath === '..' || normalizedPath.startsWith(`..${path.sep}`)) {
      throw new Error(`manifest path is outside the runtime root: ${relativePath}`)
    }

    const filePath = path.join(stageRoot, normalizedPath)
    let content
    try {
      content = await readFile(filePath)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new Error(`manifest file is missing from the staged runtime: ${relativePath}`)
      }
      throw error
    }

    const actualHash = createHash('sha256').update(content).digest('hex')
    if (actualHash !== expectedHash) {
      throw new Error(
        `checksum mismatch for ${relativePath}: expected ${expectedHash}, got ${actualHash}`,
      )
    }
  }
}

/**
 * Resolve the installed optional binary package next to this module.
 * @returns {string|null} its package root, or null when the optional dependency is absent.
 */
function resolveBinaryPackageRoot() {
  try {
    const require = createRequire(import.meta.url)
    return path.dirname(require.resolve('dsh-labview-mcp-win32-x64/package.json'))
  } catch {
    return null
  }
}

/**
 * Versioned runtime provisioning for the LabVIEW MCP binary package.
 *
 * The service is constructed with its environment injected so tests can use a
 * fixture binary package and a temporary tools root. All methods are safe to
 * call concurrently; `ensure()` shares one in-flight provisioning pass.
 */
export class LabviewService {
  #binaryPackageRoot
  #toolsRoot
  #registrar
  #platform
  #arch
  #inflight = null
  #provisioningInfo = null
  #activeVersionDir = null
  #lastError = undefined

  /**
   * @param {object} options
   * @param {string|null} [options.binaryPackageRoot] installed platform binary package root.
   * @param {string} [options.toolsRoot] directory holding version subdirectories.
   * @param {object} [options.registrar] MCP registration seam (used by a later ticket).
   * @param {string} [options.platform] defaults to `process.platform`.
   * @param {string} [options.arch] defaults to `process.arch`.
   * @param {string} [options.homeDir] defaults to `os.homedir()` when `toolsRoot` is omitted.
   */
  constructor({
    binaryPackageRoot = null,
    toolsRoot,
    registrar = null,
    platform = process.platform,
    arch = process.arch,
    homeDir,
  } = {}) {
    const home = homeDir ?? os.homedir()
    this.#binaryPackageRoot = binaryPackageRoot ?? null
    this.#toolsRoot = toolsRoot ?? path.join(home, '.dsh', 'tools', 'labview-mcp')
    this.#registrar = registrar
    this.#platform = platform
    this.#arch = arch
  }

  /** Whether this service can provision on the injected platform. */
  get #supported() {
    return isSupportedPlatform(this.#platform, this.#arch)
  }

  /** The status payload shared by every return value. */
  get #baseStatus() {
    return { platform: this.#platform, arch: this.#arch }
  }

  /** Absolute directory for one binary version. */
  #versionDir(version) {
    return path.join(this.#toolsRoot, version)
  }

  /**
   * Read the binary package's own version metadata.
   * @returns {Promise<{packageRoot: string, version: string, runtimeDir: string}>}
   */
  async #readBinaryInfo() {
    if (!this.#binaryPackageRoot) {
      throw new Error('platform binary package is not installed')
    }

    const packageRoot = this.#binaryPackageRoot
    const metadataPath = path.join(packageRoot, 'package.json')
    let rawMetadata
    try {
      rawMetadata = await readFile(metadataPath, 'utf8')
    } catch (error) {
      throw new Error(
        `platform binary package is not readable at ${packageRoot} (${error?.code ?? errorMessage(error)})`,
      )
    }

    let metadata
    try {
      metadata = JSON.parse(rawMetadata)
    } catch (error) {
      throw new Error(`platform binary package metadata is invalid at ${metadataPath}: ${errorMessage(error)}`)
    }

    const version = typeof metadata?.version === 'string' ? metadata.version.trim() : ''
    if (!version) {
      throw new Error(`platform binary package metadata has no version: ${metadataPath}`)
    }

    return {
      packageRoot,
      version,
      runtimeDir: path.join(packageRoot, 'runtime'),
    }
  }

  /**
   * Cheap, read-only status. Never hashes the provisioned tree.
   * @returns {Promise<object>} a `LabviewStatus` payload.
   */
  async status() {
    const base = this.#baseStatus

    if (!this.#supported) {
      return {
        state: 'unsupported',
        ...base,
        lastError: `unsupported platform: ${this.#platform}/${this.#arch} (only win32/x64 is supported)`,
      }
    }

    if (this.#inflight) {
      return {
        state: 'provisioning',
        ...base,
        ...(this.#provisioningInfo ?? {}),
      }
    }

    let info
    try {
      info = await this.#readBinaryInfo()
    } catch (error) {
      return {
        state: 'missing',
        ...base,
        lastError: errorMessage(error),
      }
    }

    const versionDir = this.#versionDir(info.version)
    const executablePath = path.join(versionDir, EXECUTABLE_RELATIVE_PATH)

    try {
      if (await isFile(executablePath)) {
        return {
          state: 'ready',
          ...base,
          binaryVersion: info.version,
          toolsDir: versionDir,
        }
      }
    } catch (error) {
      return {
        state: 'broken',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
        lastError: errorMessage(error),
      }
    }

    try {
      if (await pathExists(versionDir)) {
        return {
          state: 'broken',
          ...base,
          binaryVersion: info.version,
          toolsDir: versionDir,
          lastError: `runtime at ${versionDir} is incomplete: ${EXECUTABLE_RELATIVE_PATH} is missing`,
        }
      }
    } catch (error) {
      return {
        state: 'broken',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
        lastError: errorMessage(error),
      }
    }

    return {
      state: 'missing',
      ...base,
      binaryVersion: info.version,
      toolsDir: versionDir,
      ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }),
    }
  }

  /**
   * Provision the runtime when necessary. Concurrent calls share one pass.
   * @returns {Promise<object>} a `LabviewStatus` payload.
   */
  ensure() {
    return this.#startEnsure(false)
  }

  /**
   * Re-run provisioning. `force: true` recopies even a healthy runtime.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object>} a `LabviewStatus` payload.
   */
  repair(options = {}) {
    return this.#startEnsure(options?.force === true)
  }

  /**
   * Release resources owned by the service. The MCP registration seam arrives
   * in a later ticket; this keeps the lifecycle contract stable meanwhile.
   */
  async dispose() {
    // No registration exists yet, so there is nothing to dispose.
  }

  /** Start or join the single in-flight provisioning pass. */
  #startEnsure(force) {
    if (this.#inflight) return this.#inflight

    const promise = this.#provision(force)
    this.#inflight = promise
    const clear = () => {
      if (this.#inflight === promise) this.#inflight = null
    }
    promise.then(clear, clear)
    return promise
  }

  /** One provisioning attempt. Never rejects: failures become `broken` status. */
  async #provision(force) {
    const base = this.#baseStatus

    if (!this.#supported) {
      return {
        state: 'unsupported',
        ...base,
        lastError: `unsupported platform: ${this.#platform}/${this.#arch} (only win32/x64 is supported)`,
      }
    }

    let info
    try {
      info = await this.#readBinaryInfo()
    } catch (error) {
      const message = errorMessage(error)
      this.#lastError = message
      return { state: 'missing', ...base, lastError: message }
    }

    const versionDir = this.#versionDir(info.version)
    const executablePath = path.join(versionDir, EXECUTABLE_RELATIVE_PATH)
    this.#provisioningInfo = { binaryVersion: info.version, toolsDir: versionDir }
    let stageDir = null

    try {
      if (!force && await isFile(executablePath)) {
        this.#activeVersionDir = versionDir
        this.#lastError = undefined
        return {
          state: 'ready',
          ...base,
          binaryVersion: info.version,
          toolsDir: versionDir,
        }
      }

      await mkdir(this.#toolsRoot, { recursive: true })
      await this.#removeStaleStages()

      if (await pathExists(versionDir)) {
        await rm(versionDir, { recursive: true, force: true })
      }

      stageDir = path.join(this.#toolsRoot, `${STAGING_PREFIX}${randomUUID()}`)
      try {
        await cp(info.runtimeDir, stageDir, { recursive: true })
      } catch (error) {
        throw new Error(`failed to copy runtime from ${info.runtimeDir}: ${errorMessage(error)}`)
      }

      await copyIfExists(
        path.join(info.packageRoot, 'VERSION.txt'),
        path.join(stageDir, 'VERSION.txt'),
      )
      await copyIfExists(
        path.join(info.packageRoot, 'labview-mcp.manifest.sha256'),
        path.join(stageDir, 'labview-mcp.manifest.sha256'),
      )
      await verifyStageAgainstManifest(
        stageDir,
        path.join(info.packageRoot, 'labview-mcp.manifest.sha256'),
      )
      if (!await isFile(path.join(stageDir, EXECUTABLE_RELATIVE_PATH))) {
        throw new Error(`staged runtime is missing ${EXECUTABLE_RELATIVE_PATH}`)
      }

      await rename(stageDir, versionDir)
      stageDir = null
      this.#activeVersionDir = versionDir
      this.#lastError = undefined
      await this.#pruneVersions()

      return {
        state: 'ready',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
      }
    } catch (error) {
      const message = errorMessage(error)
      this.#lastError = message
      if (stageDir) {
        try {
          await rm(stageDir, { recursive: true, force: true })
        } catch {
          // An undeletable stage is never reported as ready; leave it for the next sweep.
        }
      }
      return {
        state: 'broken',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
        lastError: message,
      }
    } finally {
      this.#provisioningInfo = null
    }
  }

  /** Remove leftovers of interrupted provisioning runs. */
  async #removeStaleStages() {
    let entries
    try {
      entries = await readdir(this.#toolsRoot, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue
      try {
        await rm(path.join(this.#toolsRoot, entry.name), { recursive: true, force: true })
      } catch {
        // Tolerate locked leftovers; they can never be mistaken for a version directory.
      }
    }
  }

  /** Keep the two newest version directories, never deleting the in-use one. */
  async #pruneVersions() {
    let entries
    try {
      entries = await readdir(this.#toolsRoot, { withFileTypes: true })
    } catch {
      return
    }

    const versions = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => parseVersionDirectory(entry.name))
      .filter((parsed) => parsed !== null)
      .sort(compareVersionDirectories)

    const keep = new Set(versions.slice(0, 2).map((version) => version.name))

    for (const version of versions) {
      if (keep.has(version.name)) continue
      const versionDir = path.join(this.#toolsRoot, version.name)
      if (this.#activeVersionDir && samePath(versionDir, this.#activeVersionDir)) continue
      try {
        await rm(versionDir, { recursive: true, force: true })
      } catch {
        // A directory still held open by a running executable stays until a later run.
      }
    }
  }
}

/**
 * Render a status payload as stable, human-readable `key: value` lines.
 * @param {unknown} _args - unused tool arguments.
 * @param {object} value - status payload.
 * @returns {Array<{type: 'text', text: string}>} one text content block.
 */
function renderStatus(_args, value) {
  const fields = [
    'state',
    'platform',
    'arch',
    'binaryVersion',
    'serverVersion',
    'toolCount',
    'toolsDir',
    'lastError',
  ]
  const lines = fields
    .filter((field) => value[field] !== undefined && value[field] !== null)
    .map((field) => `${field}: ${value[field]}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

const statusOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['state', 'platform', 'arch'],
    properties: {
      state: { type: 'string', enum: STATES },
      platform: { type: 'string' },
      arch: { type: 'string' },
      binaryVersion: { type: 'string' },
      serverVersion: { type: 'string' },
      toolCount: { type: 'integer' },
      toolsDir: { type: 'string' },
      lastError: { type: 'string' },
    },
  },
  render: renderStatus,
}

/**
 * Register the native diagnostic tools and start provisioning in the
 * background for the lifetime of the plugin fiber.
 * @param {object} ctx - Host plugin context carrying the `tools` service and `effect`.
 * @param {object} _config - plugin row config.
 */
export function apply(ctx, _config) {
  const service = new LabviewService({
    binaryPackageRoot: resolveBinaryPackageRoot(),
    toolsRoot: path.join(os.homedir(), '.dsh', 'tools', 'labview-mcp'),
    platform: process.platform,
    arch: process.arch,
    homeDir: os.homedir(),
  })

  const statusTool = {
    name: 'labview_mcp_status',
    description: STATUS_DESCRIPTION,
    parameters: {},
    output: statusOutput,
    async execute() {
      return service.status()
    },
  }

  const repairTool = {
    name: 'labview_mcp_repair',
    description: REPAIR_DESCRIPTION,
    parameters: {
      force: {
        type: 'boolean',
        description: 'Recopy the runtime even when it looks intact.',
      },
    },
    output: statusOutput,
    async execute(args) {
      return service.repair({ force: args?.force === true })
    },
  }

  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.effect(() => ctx.tools.register(repairTool))

  ctx.effect(() => {
    // Provision in the background: `apply` must never block Host start-up.
    void service.ensure().catch((error) => {
      const message = errorMessage(error)
      if (typeof ctx.logger?.warn === 'function') {
        ctx.logger.warn(`[labview-mcp] background provisioning failed: ${message}`)
      }
    })
    return () => service.dispose()
  })
}
