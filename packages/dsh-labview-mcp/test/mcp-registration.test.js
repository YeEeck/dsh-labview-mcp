import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Config, LabviewService } from '../index.js'

const temporaryDirectories = []

/** Create a temp directory that is removed when this test file finishes. */
async function makeTemporaryDirectory(prefix = 'labview-mcp-registration-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** True when a path exists. */
async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** SHA-256 hex digest of a buffer or string. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Recursively collect file paths relative to a root, using forward slashes. */
async function collectRelativeFiles(rootDirectory) {
  const files = []

  async function walk(currentDirectory, prefix) {
    for (const entry of await readdir(currentDirectory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(currentDirectory, entry.name), relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      }
    }
  }

  await walk(rootDirectory, '')
  return files.sort()
}

/**
 * Build a minimal fixture `dsh-labview-mcp-win32-x64` package.
 * @returns {Promise<{root: string, runtimeDir: string, version: string}>}
 */
async function buildBinaryPackage({ version = '3.1.0', includeManifest = true } = {}) {
  const root = await makeTemporaryDirectory('labview-registration-pkg-')
  const runtimeDir = path.join(root, 'runtime')
  const files = {
    'bin/LabVIEWMCP.exe': `fixture executable ${version}\n`,
    'bin/pylabview/README.txt': 'pylabview fixture\n',
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(runtimeDir, ...relativePath.split('/'))
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  const versionTxt = `tag: v${version}\nversion: ${version}\ncommit: fixture\n`
  await writeFile(path.join(root, 'VERSION.txt'), versionTxt)
  await writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'dsh-labview-mcp-win32-x64', version, private: true }, null, 2)}\n`,
  )

  if (includeManifest) {
    const entries = []
    for (const relativePath of await collectRelativeFiles(runtimeDir)) {
      const content = await readFile(path.join(runtimeDir, ...relativePath.split('/')))
      entries.push([relativePath, sha256(content)])
    }
    entries.push(['VERSION.txt', sha256(versionTxt)])
    const manifest = `${entries.map(([relativePath, digest]) => `${digest}  ${relativePath}`).join('\n')}\n`
    await writeFile(path.join(root, 'labview-mcp.manifest.sha256'), manifest)
  }

  return { root, runtimeDir, version }
}

/**
 * Fake `ctx.mcpManager`. Records every register/probe call and models `list()`
 * with configured/foreign rows plus live plugin registrations.
 */
function createFakeRegistrar({
  initialServers = [],
  connected = true,
  toolCount = 121,
  serverVersion = '3.1.0',
  statusAfterRegister,
  registerError,
} = {}) {
  const calls = { register: [], probe: [], list: 0 }
  const live = new Map()
  const disposals = []
  const external = initialServers.map((server) => ({ ...server }))

  return {
    calls,
    disposals,
    liveNames() {
      return [...live.keys()]
    },
    list() {
      calls.list += 1
      return [
        ...external.map((server) => ({ ...server })),
        ...[...live.entries()].map(([name, record]) => ({
          name,
          configured: false,
          status: record.status,
        })),
      ]
    },
    register(name, entry) {
      if (registerError) throw new Error(registerError)
      if (external.some((server) => server.name === name) || live.has(name)) {
        throw new Error(`mcp-manager: server "${name}" is already configured or registered`)
      }
      calls.register.push({ name, entry })
      live.set(name, {
        entry,
        status: statusAfterRegister ?? (connected
          ? { state: 'connected', toolCount, connectedAt: Date.now() }
          : { state: 'connecting', attempt: 0 }),
      })
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        disposals.push(name)
        live.delete(name)
      }
    },
    probe(name) {
      calls.probe.push(name)
      return {
        ok: true,
        serverInfo: { name, version: serverVersion },
        toolNames: ['pylv_status'],
        truncated: false,
        durationMs: 1,
      }
    },
    withdraw(name) {
      live.delete(name)
    },
    setStatus(name, status) {
      const record = live.get(name)
      if (record) record.status = status
    },
  }
}

/** Build a ready-to-provision service over a fresh fixture package. */
async function makeService({ registrar, toolCallTimeoutMs, mcpStartupTimeoutMs } = {}) {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    registrar: registrar ?? createFakeRegistrar(),
    platform: 'win32',
    arch: 'x64',
    ...(toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs }),
    ...(mcpStartupTimeoutMs === undefined ? {} : { mcpStartupTimeoutMs }),
  })
  return { service, toolsRoot, fixture }
}

test('ready: registers the exact stdio entry once and reports identity', async () => {
  const registrar = createFakeRegistrar({ toolCount: 121, serverVersion: '3.1.0' })
  const { service, toolsRoot } = await makeService({ registrar })

  assert.equal((await service.status()).state, 'missing')

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'ready')
  assert.equal(ensured.binaryVersion, '3.1.0')
  assert.equal(ensured.toolsDir, path.join(toolsRoot, '3.1.0'))
  assert.equal(ensured.serverVersion, '3.1.0')
  assert.equal(ensured.toolCount, 121)

  assert.equal(registrar.calls.register.length, 1)
  assert.deepEqual(registrar.calls.register[0], {
    name: 'labview',
    entry: {
      transport: 'stdio',
      command: path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe'),
      cwd: path.join(toolsRoot, '3.1.0', 'bin'),
      toolCallTimeoutMs: 300000,
      startupTimeoutMs: 120000,
    },
  })
  assert.deepEqual(registrar.calls.probe, ['labview'])
  assert.deepEqual(registrar.liveNames(), ['labview'])

  const status = await service.status()
  assert.equal(status.state, 'ready')
  assert.equal(status.serverVersion, '3.1.0')
  assert.equal(status.toolCount, 121)
  assert.equal(status.toolsDir, path.join(toolsRoot, '3.1.0'))
  assert.equal(status.binaryVersion, '3.1.0')
  assert.equal(registrar.calls.register.length, 1)
  assert.equal(registrar.calls.probe.length, 1, 'status must use the cached probe result')
})

test('an injected toolCallTimeoutMs reaches the registration entry', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar, toolCallTimeoutMs: 45000 })

  assert.equal((await service.ensure()).state, 'ready')
  assert.equal(registrar.calls.register[0].entry.toolCallTimeoutMs, 45000)
})

test('idempotent ensure: concurrent and repeated calls register exactly once', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar })

  const first = service.ensure()
  const second = service.ensure()
  assert.equal(first, second, 'concurrent ensure calls share one pass')

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.state, 'ready')
  assert.equal(secondResult.state, 'ready')

  await service.ensure()
  await service.ensure()

  assert.equal(registrar.calls.register.length, 1)
  assert.deepEqual(registrar.liveNames(), ['labview'])
})

test('conflict: a foreign labview server blocks registration', async () => {
  const registrar = createFakeRegistrar({
    initialServers: [
      { name: 'labview', configured: true, status: { state: 'connected', toolCount: 7 } },
    ],
  })
  const { service } = await makeService({ registrar })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'conflict')
  assert.match(ensured.lastError, /already configured or registered/)
  assert.match(ensured.lastError, /remove/)
  assert.match(ensured.lastError, /labview_mcp_repair/)
  assert.equal(registrar.calls.register.length, 0)

  const status = await service.status()
  assert.equal(status.state, 'conflict')
  assert.match(status.lastError, /already configured or registered/)
  assert.equal(registrar.calls.register.length, 0)
})

test('repair disposes the old registration and registers again without duplicates', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar })

  assert.equal((await service.ensure()).state, 'ready')
  assert.equal(registrar.calls.register.length, 1)
  assert.deepEqual(registrar.disposals, [])

  const repaired = await service.repair()
  assert.equal(repaired.state, 'ready')
  assert.equal(registrar.calls.register.length, 2)
  assert.deepEqual(registrar.disposals, ['labview'])
  assert.deepEqual(registrar.liveNames(), ['labview'])
  assert.deepEqual(registrar.calls.register[1].entry, registrar.calls.register[0].entry)

  const repairedAgain = await service.repair()
  assert.equal(repairedAgain.state, 'ready')
  assert.equal(registrar.calls.register.length, 3)
  assert.deepEqual(registrar.disposals, ['labview', 'labview'])
  assert.deepEqual(registrar.liveNames(), ['labview'])
})

test('concurrent ensure and repair leave exactly one live registration', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar })

  await Promise.all([service.ensure(), service.repair()])

  assert.deepEqual(registrar.liveNames(), ['labview'])
  assert.equal(registrar.calls.register.length >= 1, true)
})

test('dispose calls the disposer and later calls do not resurrect the registration', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar })

  assert.equal((await service.ensure()).state, 'ready')
  assert.deepEqual(registrar.liveNames(), ['labview'])

  await service.dispose()
  assert.deepEqual(registrar.disposals, ['labview'])
  assert.deepEqual(registrar.liveNames(), [])

  const status = await service.status()
  assert.equal(status.state, 'ready')
  assert.equal(registrar.calls.register.length, 1)

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'ready')
  assert.equal(registrar.calls.register.length, 1)
  assert.deepEqual(registrar.liveNames(), [])
})

test('unsupported, missing, and broken runtimes never register', async () => {
  const unsupportedRegistrar = createFakeRegistrar()
  const unsupported = new LabviewService({
    binaryPackageRoot: (await buildBinaryPackage()).root,
    toolsRoot: path.join(await makeTemporaryDirectory(), 'tools'),
    registrar: unsupportedRegistrar,
    platform: 'darwin',
    arch: 'arm64',
  })
  assert.equal((await unsupported.ensure()).state, 'unsupported')
  assert.equal(unsupportedRegistrar.calls.register.length, 0)

  const missingRegistrar = createFakeRegistrar()
  const missing = new LabviewService({
    binaryPackageRoot: null,
    toolsRoot: path.join(await makeTemporaryDirectory(), 'tools'),
    registrar: missingRegistrar,
    platform: 'win32',
    arch: 'x64',
  })
  assert.equal((await missing.ensure()).state, 'missing')
  assert.equal(missingRegistrar.calls.register.length, 0)

  const brokenRegistrar = createFakeRegistrar()
  const brokenWorkspace = await makeTemporaryDirectory()
  const brokenFixture = await buildBinaryPackage()
  const manifestPath = path.join(brokenFixture.root, 'labview-mcp.manifest.sha256')
  const lines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n')
  const executableLineIndex = lines.findIndex((line) => line.endsWith('  bin/LabVIEWMCP.exe'))
  assert.notEqual(executableLineIndex, -1)
  lines[executableLineIndex] = `${'0'.repeat(64)}  bin/LabVIEWMCP.exe`
  await writeFile(manifestPath, `${lines.join('\n')}\n`)
  const broken = new LabviewService({
    binaryPackageRoot: brokenFixture.root,
    toolsRoot: path.join(brokenWorkspace, 'tools'),
    registrar: brokenRegistrar,
    platform: 'win32',
    arch: 'x64',
  })
  const brokenStatus = await broken.ensure()
  assert.equal(brokenStatus.state, 'broken')
  assert.match(brokenStatus.lastError, /checksum mismatch/i)
  assert.equal(brokenRegistrar.calls.register.length, 0)
  assert.equal(await exists(path.join(brokenWorkspace, 'tools', '3.1.0')), false)
})

test('a generic register() failure is persisted and reported as broken by status()', async () => {
  const registrar = createFakeRegistrar({ registerError: 'spawn failed: access denied' })
  const { service } = await makeService({ registrar })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'broken')
  assert.match(ensured.lastError, /failed to register/)
  assert.match(ensured.lastError, /access denied/)

  const status = await service.status()
  assert.equal(status.state, 'broken')
  assert.match(status.lastError, /failed to register/)
  assert.match(status.lastError, /access denied/)
  assert.equal(status.serverVersion, undefined)
  assert.equal(status.toolCount, undefined)
})

test('a live connecting registration is reported as provisioning, never ready', async () => {
  const registrar = createFakeRegistrar({ connected: false })
  const { service } = await makeService({ registrar, mcpStartupTimeoutMs: 50 })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'broken')
  assert.match(ensured.lastError, /connecting|did not report connected/i)

  const status = await service.status()
  assert.equal(status.state, 'provisioning')
  assert.equal(status.serverVersion, undefined)
  assert.equal(status.toolCount, undefined)
})

test('a failed live registration is reported as broken', async () => {
  const registrar = createFakeRegistrar({
    statusAfterRegister: { state: 'failed', reason: 'gave-up', lastError: 'child exited' },
  })
  const { service } = await makeService({ registrar })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'broken')
  assert.match(ensured.lastError, /failed/)
  assert.match(ensured.lastError, /child exited/)
  assert.equal(registrar.calls.register.length, 1)

  const status = await service.status()
  assert.equal(status.state, 'broken')
  assert.match(status.lastError, /child exited/)
})

test('a registration that disappears unexpectedly is reported as broken', async () => {
  const registrar = createFakeRegistrar()
  const { service } = await makeService({ registrar })

  assert.equal((await service.ensure()).state, 'ready')
  registrar.withdraw('labview')

  const status = await service.status()
  assert.equal(status.state, 'broken')
  assert.match(status.lastError, /disappeared unexpectedly/)
  assert.match(status.lastError, /labview_mcp_repair/)
})

test('Config validates toolCallTimeoutMs with a 300000 default', () => {
  const validate = Config['~standard'].validate
  assert.equal(Config['~standard'].version, 1)

  assert.deepEqual(validate({}), { value: { toolCallTimeoutMs: 300000 } })
  assert.deepEqual(validate(undefined), { value: { toolCallTimeoutMs: 300000 } })
  assert.deepEqual(validate({ toolCallTimeoutMs: 1234 }), { value: { toolCallTimeoutMs: 1234 } })

  for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, '300000', null]) {
    const result = validate({ toolCallTimeoutMs: invalid })
    assert.equal(Array.isArray(result.issues), true, `expected issues for ${String(invalid)}`)
    assert.match(result.issues[0].message, /positive finite number/)
  }

  const unknown = validate({ toolCallTimeoutMs: 1000, extra: true })
  assert.equal(Array.isArray(unknown.issues), true)
  assert.match(unknown.issues[0].message, /unknown config option/)
})
