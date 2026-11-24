/**
 * Host plugin for the dsh-labview-mcp bundle.
 *
 * `LabviewService` is the single test seam for the product. Production wiring
 * resolves the optional platform binary package and supplies a versioned tools
 * root under the user's DSH directory. After provisioning succeeds the service
 * registers the `labview` MCP server with the injected manager, and the plugin
 * lifetime effect owns that registration.
 */

import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { copyFile, cp, mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

import { createStatusRoutes } from './status-routes.js'

export const inject = ['tools', 'mcpManager']

const STATES = ['unsupported', 'missing', 'provisioning', 'ready', 'broken', 'conflict']

const SUPPORTED_PLATFORM = 'win32'
const SUPPORTED_ARCH = 'x64'

const STAGING_PREFIX = '.staging-'
const BACKUP_SUFFIX = '.old-'
const EXECUTABLE_RELATIVE_PATH = path.join('bin', 'LabVIEWMCP.exe')
const VERSION_DIR_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+](.*))?$/

const MCP_SERVER_NAME = 'labview'
const BINARY_PACKAGE_NAME = 'dsh-labview-mcp-win32-x64'

/**
 * The platform package range this plugin requires, read from the plugin's own
 * manifest so a dependency move cannot leave a stale copy behind in a message.
 */
function readBinaryPackageRange() {
  try {
    const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    return manifest?.dependencies?.[BINARY_PACKAGE_NAME]
      ?? manifest?.optionalDependencies?.[BINARY_PACKAGE_NAME]
      ?? null
  } catch {
    return null
  }
}

const BINARY_PACKAGE_RANGE = readBinaryPackageRange()
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 300_000
const MCP_STARTUP_TIMEOUT_MS = 120_000
const DEFAULT_REGISTRATION_CLOSE_TIMEOUT_MS = 10_000
const REGISTRATION_POLL_INTERVAL_MS = 50

/** Message shown whenever another `labview` server owns the name. */
const LABVIEW_CONFLICT_MESSAGE =
  'a "labview" MCP server is already configured or registered by another source; remove that '
  + 'server (for example the old dsh-labview-mcp v1 bundle) and run labview_mcp_repair so this '
  + 'plugin can register its own "labview" server'

/** True when a value is usable as the per-tool-call timeout. */
function isValidToolCallTimeout(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

/**
 * Plugin config schema: Standard Schema V1, hand-rolled so the package keeps no
 * runtime dependency. Only the per-tool-call timeout is user-tunable.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-labview-mcp',
    validate(value) {
      const raw = value === undefined ? {} : value
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object' }] }
      }

      const unknownKeys = Object.keys(raw).filter((key) => key !== 'toolCallTimeoutMs')
      if (unknownKeys.length > 0) {
        return {
          issues: unknownKeys.map((key) => ({
            message: `unknown config option "${key}"`,
            path: [key],
          })),
        }
      }

      const toolCallTimeoutMs = raw.toolCallTimeoutMs === undefined
        ? DEFAULT_TOOL_CALL_TIMEOUT_MS
        : raw.toolCallTimeoutMs
      if (!isValidToolCallTimeout(toolCallTimeoutMs)) {
        return {
          issues: [{
            message: 'toolCallTimeoutMs must be a positive finite number',
            path: ['toolCallTimeoutMs'],
          }],
        }
      }

      return { value: { toolCallTimeoutMs } }
    },
  },
}

/** Resolve after `milliseconds`, used for bounded registration polling. */
function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

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
  #toolCallTimeoutMs
  #mcpStartupTimeoutMs
  #registrationCloseTimeoutMs
  #inflight = null
  #provisioningInfo = null
  #activeVersionDir = null
  #lastError = undefined
  #lastProvisionFailure = null
  #lastRegistrationFailure = null
  #registration = null
  #registrationPromise = null
  #releasePromise = null
  #releasing = false
  #disposed = false
  #repairTail = Promise.resolve()
  #serverVersion = undefined

  /**
   * @param {object} options
   * @param {string|null} [options.binaryPackageRoot] installed platform binary package root.
   * @param {string} [options.toolsRoot] directory holding version subdirectories.
   * @param {object|null} [options.registrar] MCP manager seam (`ctx.mcpManager` in production).
   * @param {string} [options.platform] defaults to `process.platform`.
   * @param {string} [options.arch] defaults to `process.arch`.
   * @param {number} [options.toolCallTimeoutMs] per-tool-call timeout for the registered server.
   * @param {number} [options.mcpStartupTimeoutMs] registration entry startup budget and connect wait.
   * @param {number} [options.registrationCloseTimeoutMs] bounded wait for a disposed registration.
   */
  constructor({
    binaryPackageRoot = null,
    toolsRoot,
    registrar = null,
    platform = process.platform,
    arch = process.arch,
    toolCallTimeoutMs = DEFAULT_TOOL_CALL_TIMEOUT_MS,
    mcpStartupTimeoutMs = MCP_STARTUP_TIMEOUT_MS,
    registrationCloseTimeoutMs = DEFAULT_REGISTRATION_CLOSE_TIMEOUT_MS,
  } = {}) {
    if (!isValidToolCallTimeout(toolCallTimeoutMs)) {
      throw new TypeError('toolCallTimeoutMs must be a positive finite number')
    }

    this.#binaryPackageRoot = binaryPackageRoot ?? null
    this.#toolsRoot = toolsRoot
      ?? path.join(os.homedir(), '.dsh', 'tools', 'labview-mcp')
    this.#registrar = registrar
    this.#platform = platform
    this.#arch = arch
    this.#toolCallTimeoutMs = toolCallTimeoutMs
    this.#mcpStartupTimeoutMs = mcpStartupTimeoutMs
    this.#registrationCloseTimeoutMs = registrationCloseTimeoutMs
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
      const required = BINARY_PACKAGE_RANGE ? `${BINARY_PACKAGE_NAME}@${BINARY_PACKAGE_RANGE}` : BINARY_PACKAGE_NAME
      throw new Error(
        `${required} is not installed; reinstall dsh-labview-mcp `
        + '(a package mirror may not carry the 57 MB runtime package yet)',
      )
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
        return await this.#describeRegistration({
          state: 'ready',
          ...base,
          binaryVersion: info.version,
          toolsDir: versionDir,
        })
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

    const provisionFailure = this.#lastProvisionFailure
    if (provisionFailure
      && provisionFailure.binaryVersion === info.version
      && samePath(provisionFailure.toolsDir, versionDir)) {
      return {
        state: 'broken',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
        lastError: provisionFailure.lastError,
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
   * Re-run provisioning and replace the MCP registration. `force: true`
   * recopies even a healthy runtime. Repeated calls are serialized and leave at
   * most one live registration.
   * @param {{force?: boolean}} [options]
   * @returns {Promise<object>} a `LabviewStatus` payload.
   */
  repair(options = {}) {
    const force = options?.force === true
    const run = this.#repairTail.then(async () => {
      if (this.#disposed) return this.status()
      if (this.#inflight) await this.#inflight.catch(() => {})
      if (this.#registrationPromise) await this.#registrationPromise.catch(() => {})
      await this.#releaseRegistration()
      this.#serverVersion = undefined
      return this.#startEnsure(force)
    })
    this.#repairTail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Dispose the MCP registration and wait until the manager has withdrawn it.
   * A disposed service never registers again.
   */
  async dispose() {
    this.#disposed = true
    await this.#releaseRegistration()
  }

  /** The stdio registration entry for one provisioned runtime directory. */
  #registrationEntry(versionDir) {
    const binDirectory = path.join(versionDir, 'bin')
    return {
      transport: 'stdio',
      command: path.join(binDirectory, 'LabVIEWMCP.exe'),
      cwd: binDirectory,
      toolCallTimeoutMs: this.#toolCallTimeoutMs,
      startupTimeoutMs: this.#mcpStartupTimeoutMs,
    }
  }

  /** Read `registrar.list()`, accepting a synchronous or promise-returning fake. */
  async #listServers() {
    const listed = await this.#registrar.list()
    return Array.isArray(listed) ? listed : []
  }

  /** Find the live `labview` row in a manager list. */
  #findLabview(list) {
    return list.find((server) => server?.name === MCP_SERVER_NAME)
  }

  /**
   * Decorate a ready runtime status with the live registration's health.
   * Never probes: `serverVersion` is cached from registration time.
   */
  async #describeRegistration(base) {
    if (!this.#registrar || typeof this.#registrar.list !== 'function') return base

    let list
    try {
      list = await this.#listServers()
    } catch (error) {
      return {
        ...base,
        state: 'broken',
        lastError: `failed to read the MCP server list: ${errorMessage(error)}`,
      }
    }

    const existing = this.#findLabview(list)
    if (this.#registration === null) {
      if (existing && !this.#releasing) {
        return { ...base, state: 'conflict', lastError: LABVIEW_CONFLICT_MESSAGE }
      }
      if (this.#lastRegistrationFailure) {
        return { ...base, ...this.#lastRegistrationFailure }
      }
      return base
    }

    if (!existing) {
      if (this.#releasing) return base
      return {
        ...base,
        state: 'broken',
        lastError: 'the "labview" MCP registration disappeared unexpectedly; run labview_mcp_repair to register it again',
      }
    }

    const status = existing.status ?? {}
    if (status.state === 'connected') {
      if (typeof status.toolCount === 'number' && this.#serverVersion !== undefined) {
        return {
          ...base,
          toolCount: status.toolCount,
          serverVersion: this.#serverVersion,
        }
      }
      const missing = [
        ...(typeof status.toolCount === 'number' ? [] : ['toolCount']),
        ...(this.#serverVersion === undefined ? ['serverVersion'] : []),
      ]
      return {
        ...base,
        state: 'provisioning',
        lastError: `MCP server "labview" is connected but has not reported ${missing.join(' or ')} yet`,
      }
    }
    if (status.state === 'failed') {
      return {
        ...base,
        state: 'broken',
        lastError: `MCP server "labview" failed (${status.reason ?? 'unknown'}): ${status.lastError ?? 'no diagnostic'}`,
      }
    }
    if (status.state === 'closed') {
      return {
        ...base,
        state: 'broken',
        lastError: 'MCP server "labview" closed before it became ready',
      }
    }
    if (status.state === 'waiting-credentials') {
      return {
        ...base,
        state: 'broken',
        lastError: `MCP server "labview" is waiting for credentials: ${status.lastError ?? 'no diagnostic'}`,
      }
    }
    if (status.state === 'disabled') {
      return { ...base, state: 'broken', lastError: 'the "labview" MCP server is disabled' }
    }
    return {
      ...base,
      state: 'provisioning',
      lastError: status.lastError ?? `MCP server "labview" is ${status.state ?? 'connecting'}`,
    }
  }

  /** Register once; concurrent ensure/repair calls share the in-flight attempt. */
  #ensureRegistered(base) {
    if (this.#registrationPromise) return this.#registrationPromise
    const promise = this.#registerServer(base)
    this.#registrationPromise = promise
    const clear = () => {
      if (this.#registrationPromise === promise) this.#registrationPromise = null
    }
    promise.then(clear, clear)
    return promise
  }

  /** Perform the one registration for this service instance. */
  async #registerServer(base) {
    if (this.#disposed || !this.#registrar) return base
    if (this.#registration !== null) return this.#describeRegistration(base)

    let list
    try {
      list = await this.#listServers()
    } catch (error) {
      return this.#registrationFailure(base, 'broken', `failed to read the MCP server list: ${errorMessage(error)}`)
    }
    if (this.#disposed) return base
    if (this.#findLabview(list)) {
      return this.#registrationFailure(base, 'conflict', LABVIEW_CONFLICT_MESSAGE)
    }

    if (typeof this.#registrar.register !== 'function') {
      return this.#registrationFailure(base, 'broken', 'the MCP manager does not expose register()')
    }

    let disposer
    try {
      disposer = this.#registrar.register(
        MCP_SERVER_NAME,
        this.#registrationEntry(base.toolsDir),
      )
    } catch (error) {
      const message = errorMessage(error)
      if (/already (?:configured|registered)|already exists/i.test(message)) {
        return this.#registrationFailure(base, 'conflict', `${LABVIEW_CONFLICT_MESSAGE} (${message})`)
      }
      return this.#registrationFailure(
        base,
        'broken',
        `failed to register the "labview" MCP server: ${message}`,
      )
    }

    this.#registration = typeof disposer === 'function' ? disposer : () => {}
    this.#lastRegistrationFailure = null
    this.#serverVersion = undefined
    await this.#probeServerVersion()
    if (this.#disposed) return base
    return this.#waitForConnected(base)
  }

  /** Persist a failed registration attempt so a later status() cannot report ready. */
  #registrationFailure(base, state, lastError) {
    this.#lastRegistrationFailure = { state, lastError }
    return {
      ...base,
      state,
      lastError,
    }
  }

  /** Ask the manager to probe the server; the result is cached for status. */
  async #probeServerVersion() {
    if (!this.#registrar || typeof this.#registrar.probe !== 'function') return
    try {
      const result = await this.#registrar.probe(MCP_SERVER_NAME)
      if (result?.ok === true && typeof result.serverInfo?.version === 'string') {
        this.#serverVersion = result.serverInfo.version
      }
    } catch {
      // A failed probe only omits `serverVersion`; registration health stays authoritative.
    }
  }

  /** Wait (bounded) for the registered server to report connected. */
  async #waitForConnected(base) {
    const deadline = Date.now() + this.#mcpStartupTimeoutMs
    while (true) {
      if (this.#disposed) return base
      const described = await this.#describeRegistration(base)
      if (described.state === 'broken' || described.state === 'conflict') return described
      if (described.state === 'ready' && typeof described.toolCount === 'number') return described
      if (this.#serverVersion === undefined) await this.#probeServerVersion()
      if (Date.now() >= deadline) {
        return {
          ...described,
          state: 'broken',
          lastError: described.lastError
            ?? `MCP server "labview" did not report connected within ${this.#mcpStartupTimeoutMs} ms`,
        }
      }
      await delay(Math.min(REGISTRATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    }
  }

  /** Decorate a provisioned-ready status with registration state. */
  async #afterProvisionReady(status) {
    if (!this.#registrar || this.#disposed) return status
    try {
      return await this.#ensureRegistered(status)
    } catch (error) {
      return this.#registrationFailure(status, 'broken', errorMessage(error))
    }
  }

  /** Dispose the live registration, bounded by `registrationCloseTimeoutMs`. */
  #releaseRegistration() {
    if (this.#releasePromise) return this.#releasePromise
    const registration = this.#registration
    if (registration === null) return Promise.resolve()

    this.#registration = null
    this.#releasing = true
    const promise = (async () => {
      try {
        await registration()
      } catch (error) {
        this.#lastError = `failed to dispose the MCP registration: ${errorMessage(error)}`
      }
      await this.#waitForWithdrawal()
    })().finally(() => {
      this.#releasing = false
    })
    this.#releasePromise = promise
    const clear = () => {
      if (this.#releasePromise === promise) this.#releasePromise = null
    }
    promise.then(clear, clear)
    return promise
  }

  /** Poll `registrar.list()` until our registration is gone or the budget expires. */
  async #waitForWithdrawal() {
    if (!this.#registrar || typeof this.#registrar.list !== 'function') return true
    const deadline = Date.now() + this.#registrationCloseTimeoutMs
    while (true) {
      let list = []
      try {
        list = await this.#listServers()
      } catch {
        // A transient list failure is not proof of a withdrawn registration.
      }
      if (!this.#findLabview(list)) return true
      if (Date.now() >= deadline) {
        this.#lastError =
          `timed out after ${this.#registrationCloseTimeoutMs} ms waiting for the "labview" `
          + 'MCP registration to be withdrawn'
        return false
      }
      await delay(Math.min(REGISTRATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
    }
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
        this.#lastProvisionFailure = null
        this.#lastError = undefined
        await this.#pruneVersions()
        return await this.#afterProvisionReady({
          state: 'ready',
          ...base,
          binaryVersion: info.version,
          toolsDir: versionDir,
        })
      }

      await mkdir(this.#toolsRoot, { recursive: true })
      await this.#removeStaleStages()

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

      // Swap only after the new copy is verified: the previous runtime stays
      // intact until the stage is known good, so a failed repair is harmless.
      let backupDir = null
      if (await pathExists(versionDir)) {
        backupDir = path.join(
          this.#toolsRoot,
          `${info.version}${BACKUP_SUFFIX}${randomUUID()}`,
        )
        await rename(versionDir, backupDir)
      }
      try {
        await rename(stageDir, versionDir)
        stageDir = null
      } catch (error) {
        if (backupDir) {
          try {
            await rename(backupDir, versionDir)
          } catch (restoreError) {
            throw new Error(
              `failed to move the staged runtime into ${versionDir}: ${errorMessage(error)}; `
              + `restoring ${backupDir} failed: ${errorMessage(restoreError)}`,
            )
          }
        }
        throw error
      }
      if (backupDir) {
        try {
          await rm(backupDir, { recursive: true, force: true })
        } catch {
          // A leftover backup is harmless and never mistaken for a version directory.
        }
      }

      this.#activeVersionDir = versionDir
      this.#lastProvisionFailure = null
      this.#lastError = undefined
      await this.#pruneVersions()

      return await this.#afterProvisionReady({
        state: 'ready',
        ...base,
        binaryVersion: info.version,
        toolsDir: versionDir,
      })
    } catch (error) {
      const message = errorMessage(error)
      this.#lastError = message
      this.#lastProvisionFailure = {
        binaryVersion: info.version,
        toolsDir: versionDir,
        lastError: message,
      }
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
 * Register the native diagnostic tools, the browser-visible status routes, and
 * start provisioning in the background for the lifetime of the plugin fiber.
 * Provisioning success also registers the `labview` MCP server with the
 * injected manager.
 * @param {object} ctx - Host plugin context carrying `tools`, `mcpManager`, and `effect`.
 * @param {object} [config] - validated plugin row config.
 */
export function apply(ctx, config) {
  const binaryPackageRoot = resolveBinaryPackageRoot()
  const toolsRoot = path.join(os.homedir(), '.dsh', 'tools', 'labview-mcp')
  const service = new LabviewService({
    binaryPackageRoot,
    toolsRoot,
    registrar: ctx.mcpManager ?? null,
    platform: process.platform,
    arch: process.arch,
    toolCallTimeoutMs: config?.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS,
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

  // The status panel in Plugins reads the same service over two exact Fetch
  // routes. `connection` exists only in compositions with a browser carrier, so
  // it is an optional injection: without one the plugin keeps its tools and its
  // provisioning, and simply registers no routes.
  ctx.inject(['connection'], (connectionCtx) => {
    connectionCtx.effect(() => {
      const routes = createStatusRoutes({
        service,
        binaryPackageRoot,
        binaryPackageName: BINARY_PACKAGE_NAME,
        binaryPackageRange: BINARY_PACKAGE_RANGE,
        toolsRoot,
      })
      const disposers = routes.map((route) => connectionCtx.connection.fetch.register(route))
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  })

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
