import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LabviewService } from '../index.js'

const VERSION_DIR_PATTERN = /^\d+\.\d+\.\d+(?:[-+].*)?$/
const temporaryDirectories = []

/** Create a temp directory that is removed when this test file finishes. */
async function makeTemporaryDirectory(prefix = 'labview-service-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** True when a path exists (any kind). */
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
    const entries = await readdir(currentDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(currentDirectory, entry.name), relativePath)
      } else if (entry.isFile()) {
        files.push(relativePath)
      }
    }
  }

  await walk(rootDirectory, '')
  return files
}

/**
 * Build a minimal fixture `dsh-labview-mcp-win32-x64` package.
 * @returns {Promise<{root: string, runtimeDir: string, version: string, runtimeFiles: object}>}
 */
async function buildBinaryPackage({ version = '3.1.0', runtimeFiles = {}, includeManifest = true } = {}) {
  const root = await makeTemporaryDirectory('labview-pkg-')
  const runtimeDir = path.join(root, 'runtime')
  const files = {
    'bin/LabVIEWMCP.exe': `fixture executable ${version}\n`,
    'bin/pylabview/README.txt': 'pylabview fixture\n',
    'bin/scripts/check.py': 'print("fixture")\n',
    ...runtimeFiles,
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

  return { root, runtimeDir, version, runtimeFiles: files }
}

/** Directory names under `toolsRoot` that look like versions. */
function versionDirectories(entries) {
  return entries
    .filter((entry) => entry.isDirectory() && VERSION_DIR_PATTERN.test(entry.name))
    .map((entry) => entry.name)
}

test('fresh provision: missing -> ensure() -> ready with a complete version directory', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage({ version: '3.1.0' })
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  const before = await service.status()
  assert.equal(before.state, 'missing')

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'ready')
  assert.equal(ensured.binaryVersion, '3.1.0')
  assert.equal(ensured.toolsDir, path.join(toolsRoot, '3.1.0'))

  await access(path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe'))
  await access(path.join(toolsRoot, '3.1.0', 'VERSION.txt'))
  await access(path.join(toolsRoot, '3.1.0', 'labview-mcp.manifest.sha256'))

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.deepEqual(versionDirectories(entries), ['3.1.0'])
  assert.equal(entries.some((entry) => entry.name.startsWith('.staging-')), false)

  const afterStatus = await service.status()
  assert.equal(afterStatus.state, 'ready')
  assert.equal(afterStatus.binaryVersion, '3.1.0')
  assert.equal(afterStatus.toolsDir, path.join(toolsRoot, '3.1.0'))
})

test('idempotence: a second ensure() does not recopy', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await service.ensure()).state, 'ready')

  const provisionedExecutable = path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe')
  await writeFile(provisionedExecutable, 'mutated after the first provision\n')

  const second = await service.ensure()
  assert.equal(second.state, 'ready')
  assert.equal(await readFile(provisionedExecutable, 'utf8'), 'mutated after the first provision\n')
})

test('partial staging and a damaged version directory are recovered; force repair recopies', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()

  await mkdir(path.join(toolsRoot, '3.1.0', 'bin'), { recursive: true })
  await mkdir(path.join(toolsRoot, '.staging-old-attempt', 'bin'), { recursive: true })
  await writeFile(path.join(toolsRoot, '.staging-old-attempt', 'bin', 'partial.txt'), 'partial')

  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await service.status()).state, 'broken')

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'ready')
  await access(path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe'))
  assert.equal(await exists(path.join(toolsRoot, '.staging-old-attempt')), false)

  const provisionedExecutable = path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe')
  await writeFile(provisionedExecutable, 'tampered\n')

  const repaired = await service.repair({ force: true })
  assert.equal(repaired.state, 'ready')
  assert.equal(await readFile(provisionedExecutable, 'utf8'), fixture.runtimeFiles['bin/LabVIEWMCP.exe'])

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.equal(entries.some((entry) => entry.name.startsWith('.staging-')), false)
})

test('non-force repair provisions a missing runtime', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  const repaired = await service.repair()
  assert.equal(repaired.state, 'ready')
  await access(path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe'))
})

test('version retention keeps the two newest version directories and leaves current/unrelated alone', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage({ version: '3.1.0' })

  for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
    await mkdir(path.join(toolsRoot, version), { recursive: true })
    await writeFile(path.join(toolsRoot, version, 'marker.txt'), version)
  }
  await mkdir(path.join(toolsRoot, 'current'), { recursive: true })
  await writeFile(path.join(toolsRoot, 'current', 'README.txt'), 'v1 runtime')
  await mkdir(path.join(toolsRoot, 'unrelated'), { recursive: true })

  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await service.ensure()).state, 'ready')

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.deepEqual(versionDirectories(entries).sort(), ['3.0.0', '3.1.0'])
  assert.equal(await exists(path.join(toolsRoot, '1.0.0')), false)
  assert.equal(await exists(path.join(toolsRoot, '2.0.0')), false)
  assert.equal(await readFile(path.join(toolsRoot, 'current', 'README.txt'), 'utf8'), 'v1 runtime')
  assert.equal(await exists(path.join(toolsRoot, 'unrelated')), true)
})

test('unsupported platform reports unsupported and copies nothing', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'darwin',
    arch: 'arm64',
  })

  const status = await service.status()
  assert.equal(status.state, 'unsupported')
  assert.match(status.lastError, /unsupported/i)

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'unsupported')
  assert.equal(await exists(toolsRoot), false)
})

test('missing binary package reports missing with a clear lastError and never crashes', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')

  const absent = new LabviewService({
    binaryPackageRoot: null,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })
  const status = await absent.status()
  assert.equal(status.state, 'missing')
  assert.match(status.lastError, /not installed/i)

  const ensured = await absent.ensure()
  assert.equal(ensured.state, 'missing')
  assert.match(ensured.lastError, /not installed/i)
  assert.equal(await exists(toolsRoot), false)

  const unreadable = new LabviewService({
    binaryPackageRoot: path.join(workspace, 'no-such-binary-package'),
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })
  const unreadableStatus = await unreadable.status()
  assert.equal(unreadableStatus.state, 'missing')
  assert.match(unreadableStatus.lastError, /not readable/i)
})

test('a runtime without bin/LabVIEWMCP.exe is broken even without a manifest', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage({ includeManifest: false })
  await rm(path.join(fixture.runtimeDir, 'bin', 'LabVIEWMCP.exe'))

  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'broken')
  assert.match(ensured.lastError, /LabVIEWMCP\.exe/)
  assert.equal(await exists(path.join(toolsRoot, '3.1.0')), false)
})

test('manifest mismatch reports broken and leaves no ready version or staging directory', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()

  const manifestPath = path.join(fixture.root, 'labview-mcp.manifest.sha256')
  const lines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n')
  const executableLineIndex = lines.findIndex((line) => line.endsWith('  bin/LabVIEWMCP.exe'))
  assert.notEqual(executableLineIndex, -1)
  lines[executableLineIndex] = `${'0'.repeat(64)}  bin/LabVIEWMCP.exe`
  await writeFile(manifestPath, `${lines.join('\n')}\n`)

  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  const ensured = await service.ensure()
  assert.equal(ensured.state, 'broken')
  assert.match(ensured.lastError, /checksum mismatch/i)
  assert.equal(await exists(path.join(toolsRoot, '3.1.0')), false)

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.equal(entries.some((entry) => entry.name.startsWith('.staging-')), false)

  const afterStatus = await service.status()
  assert.equal(afterStatus.state, 'broken')
  assert.equal(afterStatus.binaryVersion, '3.1.0')
  assert.equal(afterStatus.toolsDir, path.join(toolsRoot, '3.1.0'))
  assert.match(afterStatus.lastError, /checksum mismatch/i)
})

test('force repair with a broken source leaves the previous healthy runtime intact', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage()
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await service.ensure()).state, 'ready')
  const provisionedExecutable = path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe')
  const healthyExecutable = await readFile(provisionedExecutable, 'utf8')
  assert.equal(healthyExecutable, fixture.runtimeFiles['bin/LabVIEWMCP.exe'])

  const manifestPath = path.join(fixture.root, 'labview-mcp.manifest.sha256')
  const lines = (await readFile(manifestPath, 'utf8')).trimEnd().split('\n')
  const executableLineIndex = lines.findIndex((line) => line.endsWith('  bin/LabVIEWMCP.exe'))
  assert.notEqual(executableLineIndex, -1)
  lines[executableLineIndex] = `${'0'.repeat(64)}  bin/LabVIEWMCP.exe`
  await writeFile(manifestPath, `${lines.join('\n')}\n`)

  const repaired = await service.repair({ force: true })
  assert.equal(repaired.state, 'broken')
  assert.match(repaired.lastError, /checksum mismatch/i)

  assert.equal(await readFile(provisionedExecutable, 'utf8'), healthyExecutable)
  assert.equal(await exists(path.join(toolsRoot, '3.1.0')), true)
  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.equal(entries.some((entry) => entry.name.startsWith('.staging-')), false)
  assert.equal(entries.some((entry) => entry.name.includes('.old-')), false)
})

test('ensure() on an already-ready root prunes old version directories to two', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const fixture = await buildBinaryPackage({ version: '3.1.0' })

  await mkdir(path.join(toolsRoot, '3.1.0', 'bin'), { recursive: true })
  await writeFile(
    path.join(toolsRoot, '3.1.0', 'bin', 'LabVIEWMCP.exe'),
    'already provisioned\n',
  )
  for (const version of ['1.0.0', '2.0.0', '3.0.0']) {
    await mkdir(path.join(toolsRoot, version), { recursive: true })
    await writeFile(path.join(toolsRoot, version, 'marker.txt'), version)
  }

  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  assert.equal((await service.ensure()).state, 'ready')

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.deepEqual(versionDirectories(entries).sort(), ['3.0.0', '3.1.0'])
  assert.equal(await exists(path.join(toolsRoot, '1.0.0')), false)
  assert.equal(await exists(path.join(toolsRoot, '2.0.0')), false)
})

test('concurrent ensure calls share one provisioning pass and status reports provisioning', async () => {
  const workspace = await makeTemporaryDirectory()
  const toolsRoot = path.join(workspace, 'tools')
  const runtimeFiles = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`bin/data/file-${index}.txt`, `data ${index}\n`]),
  )
  const fixture = await buildBinaryPackage({ runtimeFiles })
  const service = new LabviewService({
    binaryPackageRoot: fixture.root,
    toolsRoot,
    platform: 'win32',
    arch: 'x64',
  })

  const first = service.ensure()
  const second = service.ensure()
  assert.equal(first, second)

  const during = await service.status()
  assert.equal(during.state, 'provisioning')

  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.state, 'ready')
  assert.equal(secondResult.state, 'ready')

  const entries = await readdir(toolsRoot, { withFileTypes: true })
  assert.equal(entries.some((entry) => entry.name.startsWith('.staging-')), false)
})
