/**
 * Focused tests for scripts/build-binary-package.mjs.
 *
 * These use a tiny fixture release tree zipped with the platform `tar.exe`
 * (`tar -a -cf`). The real 5,582-file v3.1.0 build is deliberately not part of
 * the unit suite; it is verified manually from the downloaded release zip.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  cp,
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
import { fileURLToPath } from 'node:url'
import { buildBinaryPackage, DEFAULT_OUT_DIRECTORY } from './build-binary-package.mjs'

const ASSETS_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets')
const temporaryDirectories = []

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** Create a temp directory removed when this test file ends. */
async function makeTemporaryDirectory(prefix = 'binary-package-test-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/** Run the platform tar executable. */
function runTar(args) {
  const command = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    : 'tar'
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`tar exited with ${code}: ${stderr}`))
    })
  })
}

/** SHA-256 hex digest of a buffer or string. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/** Recursively collect file paths relative to a root using forward slashes. */
async function collectFiles(root) {
  const files = []
  async function walk(currentDirectory, prefix) {
    const entries = await readdir(currentDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(currentDirectory, entry.name), relativePath)
      else if (entry.isFile()) files.push(relativePath)
    }
  }
  await walk(root, '')
  return files
}

/**
 * Build a fixture release and zip it.
 * @param {object} [options]
 * @param {boolean} [options.wrap] put the tree under one wrapping directory.
 * @param {boolean} [options.tamperManifest] corrupt the executable digest.
 * @param {Record<string,string>} [options.extraFiles] extra files written after the manifest.
 */
async function createFixture({ wrap = false, tamperManifest = false, extraFiles = {} } = {}) {
  const root = await makeTemporaryDirectory()
  const releaseDirectory = path.join(root, 'release')
  const files = {
    'VERSION.txt': 'tag: v3.1.0\nversion: 3.1.0\ncommit: fixture\n',
    'bin/LabVIEWMCP.exe': 'fixture executable\n',
    'bin/pylabview/app/LICENSE-pylabview.txt': 'pylabview fixture license\n',
    'bin/scripts/check.py': 'print("fixture")\n',
    'agents/one.md': '# fixture agent\n',
    'hooks/hooks.json': '{}\n',
    '.mcp.json': '{"mcpServers":{}}\n',
    '.claude-plugin/plugin.json': '{"name":"fixture"}\n',
  }

  for (const [relativePath, content] of Object.entries(files)) {
    const targetPath = path.join(releaseDirectory, ...relativePath.split('/'))
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  const manifestLines = []
  for (const [relativePath, content] of Object.entries(files)) {
    let digest = sha256(content)
    if (tamperManifest && relativePath === 'bin/LabVIEWMCP.exe') digest = '0'.repeat(64)
    manifestLines.push(`${digest}  ${relativePath}`)
  }
  const manifestText = `${manifestLines.join('\n')}\n`
  await writeFile(path.join(root, 'manifest.sha256'), manifestText)

  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const targetPath = path.join(releaseDirectory, ...relativePath.split('/'))
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  const zipPath = path.join(root, 'fixture.zip')
  if (wrap) {
    const parentDirectory = path.join(root, 'parent')
    const wrappedDirectory = path.join(parentDirectory, 'labview-mcp-v3.1.0')
    await mkdir(parentDirectory, { recursive: true })
    await cp(releaseDirectory, wrappedDirectory, { recursive: true })
    await runTar(['-a', '-cf', zipPath, '-C', parentDirectory, 'labview-mcp-v3.1.0'])
  } else {
    await runTar(['-a', '-cf', zipPath, '-C', releaseDirectory, '.'])
  }

  const zipStat = await stat(zipPath)
  return {
    root,
    releaseDirectory,
    zipPath,
    manifestPath: path.join(root, 'manifest.sha256'),
    sha256: await new Promise((resolve, reject) => {
      const hash = createHash('sha256')
      const stream = createReadStream(zipPath)
      stream.on('error', reject)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('end', () => resolve(hash.digest('hex')))
    }),
    size: zipStat.size,
    fileCount: (await collectFiles(releaseDirectory)).length,
    manifestText,
    files,
  }
}

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

test('a good fixture zip builds a complete binary package', async () => {
  const fixture = await createFixture()
  const outDir = path.join(fixture.root, 'dist', 'dsh-labview-mcp-win32-x64')

  const summary = await buildBinaryPackage({
    zipPath: fixture.zipPath,
    version: '3.1.0',
    outDir,
    expectedSha256: fixture.sha256,
    expectedSize: fixture.size,
    expectedFileCount: fixture.fileCount,
    pack: false,
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.version, '3.1.0')
  assert.equal(summary.outDir, outDir)
  assert.equal(summary.runtimeFileCount, fixture.fileCount)
  assert.equal(summary.manifestEntryCount, fixture.fileCount)

  await access(path.join(outDir, 'runtime', 'bin', 'LabVIEWMCP.exe'))
  await access(path.join(outDir, 'runtime', 'bin', 'pylabview', 'app', 'LICENSE-pylabview.txt'))
  await access(path.join(outDir, 'runtime', 'agents', 'one.md'))
  await access(path.join(outDir, 'runtime', '.mcp.json'))
  await access(path.join(outDir, 'VERSION.txt'))
  await access(path.join(outDir, 'labview-mcp.manifest.sha256'))
  await access(path.join(outDir, 'LICENSE'))
  await access(path.join(outDir, 'THIRD-PARTY-NOTICES.md'))

  assert.equal(await readFile(path.join(outDir, 'VERSION.txt'), 'utf8'), fixture.files['VERSION.txt'])
  assert.equal(
    await readFile(path.join(outDir, 'labview-mcp.manifest.sha256'), 'utf8'),
    fixture.manifestText,
  )
  assert.equal(
    await readFile(path.join(outDir, 'LICENSE'), 'utf8'),
    await readFile(path.join(ASSETS_DIRECTORY, 'LICENSE-Zuehlke.txt'), 'utf8'),
  )

  const notices = await readFile(path.join(outDir, 'THIRD-PARTY-NOTICES.md'), 'utf8')
  assert.match(notices, /Zuehlke/)
  assert.match(notices, /pylabview/)
  assert.match(notices, /Python 3\.12/)
  assert.match(notices, /PSF/)

  const metadata = JSON.parse(await readFile(path.join(outDir, 'package.json'), 'utf8'))
  assert.deepEqual(metadata, {
    name: 'dsh-labview-mcp-win32-x64',
    version: '3.1.0',
    description: "Zuehlke's LabVIEW MCP runtime (Windows x64) for the unofficial dsh-labview-mcp DSH plugin",
    license: 'MIT',
    os: ['win32'],
    cpu: ['x64'],
    files: ['runtime', 'VERSION.txt', 'labview-mcp.manifest.sha256', 'LICENSE', 'THIRD-PARTY-NOTICES.md'],
  })
  assert.equal('private' in metadata, false)
  assert.equal('scripts' in metadata, false)
  assert.equal('dependencies' in metadata, false)
  assert.equal('main' in metadata, false)
})

test('a single wrapping directory in the zip is handled defensively', async () => {
  const fixture = await createFixture({ wrap: true })
  const outDir = path.join(fixture.root, 'dist', 'wrapped')
  const summary = await buildBinaryPackage({
    zipPath: fixture.zipPath,
    version: '3.1.0',
    outDir,
    expectedFileCount: fixture.fileCount,
    pack: false,
  })

  assert.equal(summary.runtimeFileCount, fixture.fileCount)
  await access(path.join(outDir, 'runtime', 'bin', 'LabVIEWMCP.exe'))
  await access(path.join(outDir, 'VERSION.txt'))
})

test('checksum mismatch refuses the build without writing a package', async () => {
  const fixture = await createFixture()
  const outDir = path.join(fixture.root, 'dist', 'checksum-mismatch')

  await assert.rejects(
    buildBinaryPackage({
      zipPath: fixture.zipPath,
      version: '3.1.0',
      outDir,
      expectedSha256: '0'.repeat(64),
      expectedSize: fixture.size,
      expectedFileCount: fixture.fileCount,
      pack: false,
    }),
    /SHA-256 mismatch/i,
  )
  assert.equal(await exists(outDir), false)
})

test('size mismatch refuses the build without writing a package', async () => {
  const fixture = await createFixture()
  const outDir = path.join(fixture.root, 'dist', 'size-mismatch')

  await assert.rejects(
    buildBinaryPackage({
      zipPath: fixture.zipPath,
      version: '3.1.0',
      outDir,
      expectedSize: fixture.size + 1,
      expectedFileCount: fixture.fileCount,
      pack: false,
    }),
    /size mismatch/i,
  )
  assert.equal(await exists(outDir), false)
})

test('a manifest mismatch refuses the build without writing a package', async () => {
  const fixture = await createFixture({ tamperManifest: true })
  const outDir = path.join(fixture.root, 'dist', 'manifest-mismatch')

  await assert.rejects(
    buildBinaryPackage({
      zipPath: fixture.zipPath,
      version: '3.1.0',
      outDir,
      expectedFileCount: fixture.fileCount,
      pack: false,
    }),
    /checksum mismatch/i,
  )
  assert.equal(await exists(outDir), false)
})

test('a local cache file not listed in the manifest refuses the build', async () => {
  const fixture = await createFixture({
    extraFiles: { 'bin/scripts/__pycache__/local.cpython-312.pyc': 'local cache' },
  })
  const outDir = path.join(fixture.root, 'dist', 'cache-file')

  await assert.rejects(
    buildBinaryPackage({
      zipPath: fixture.zipPath,
      version: '3.1.0',
      outDir,
      expectedFileCount: fixture.fileCount + 1,
      pack: false,
    }),
    /local cache file/i,
  )
  assert.equal(await exists(outDir), false)
})

test('a runtime file count that differs from the expected count refuses the build', async () => {
  const fixture = await createFixture()
  const outDir = path.join(fixture.root, 'dist', 'wrong-count')

  await assert.rejects(
    buildBinaryPackage({
      zipPath: fixture.zipPath,
      version: '3.1.0',
      outDir,
      expectedFileCount: fixture.fileCount + 1,
      pack: false,
    }),
    /runtime file count/i,
  )
  assert.equal(await exists(outDir), false)
})

test('the default output directory lives under the repository dist folder', () => {
  assert.match(DEFAULT_OUT_DIRECTORY, /[\\/]dist[\\/]dsh-labview-mcp-win32-x64$/)
})
