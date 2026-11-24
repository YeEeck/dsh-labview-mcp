/**
 * Tests for scripts/release.mjs.
 *
 * Every test runs fully offline: a tiny fixture release tree is zipped with the
 * platform `tar.exe` (`tar -a -cf`), a matching manifest is generated, and a
 * fixture GitHub release JSON points at both. The real 65 MB upstream archive
 * is never downloaded here; the real-package dry run is a manual verification.
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
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
import { fileURLToPath } from 'node:url'
import {
  runRelease,
  downloadVerifiedAsset,
  checkPublishCooldown,
  readRegistryVersion,
  requestMirrorSync,
  waitForRegistryVersion,
  NPMMIRROR_REGISTRY,
  DEFAULT_MIRRORS,
} from './release.mjs'

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release.mjs')
const temporaryDirectories = []

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

/** Create a temp directory removed when this test file ends. */
async function makeTemporaryDirectory(prefix = 'release-test-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

/** Run the platform tar executable and return stdout. */
function runTar(args) {
  const command = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe')
    : 'tar'
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(`tar exited with ${code}: ${stderr}`))
    })
  })
}

/** Run the release CLI with the current Node executable. */
function runReleaseCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

/** SHA-256 hex digest of a file. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** SHA-256 hex digest of a string. */
function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Build a fixture release tree, zip it, write its manifest, and write a
 * GitHub-release-shaped JSON document referencing both assets.
 *
 * @param {object} [options]
 * @param {boolean} [options.omitExecutable] leave `bin/LabVIEWMCP.exe` out.
 * @param {boolean} [options.includeManifestAsset] include the manifest asset.
 * @param {string} [options.zipDigestOverride] replace the zip asset digest.
 * @param {boolean} [options.omitZipDigest] remove the zip asset digest.
 */
async function createFixture({
  omitExecutable = false,
  includeManifestAsset = true,
  zipDigestOverride,
  omitZipDigest = false,
} = {}) {
  const root = await makeTemporaryDirectory()
  const releaseDirectory = path.join(root, 'release')
  const files = {
    'VERSION.txt': 'tag: v3.1.99\nversion: 3.1.99\ncommit: fixture\n',
    ...(omitExecutable ? {} : { 'bin/LabVIEWMCP.exe': 'fixture executable\n' }),
    'bin/pylabview/app/LICENSE-pylabview.txt': 'pylabview fixture license\n',
    'bin/scripts/check.py': 'print("fixture")\n',
    'bin/docs/guide.md': '# fixture guide\n',
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

  const manifestLines = Object.entries(files).map(
    ([relativePath, content]) => `${sha256(content)}  ${relativePath}`,
  )
  const manifestPath = path.join(root, 'labview-mcp.manifest.sha256')
  const manifestText = `${manifestLines.join('\n')}\n`
  if (includeManifestAsset) {
    await writeFile(manifestPath, manifestText)
  }

  const zipPath = path.join(root, 'labview-mcp.zip')
  await runTar(['-a', '-cf', zipPath, '-C', releaseDirectory, '.'])

  const zipStat = await stat(zipPath)
  const zipSha256 = await sha256File(zipPath)
  const manifestStat = includeManifestAsset ? await stat(manifestPath) : null
  const manifestSha256 = includeManifestAsset ? await sha256File(manifestPath) : null

  const zipAsset = {
    name: 'labview-mcp.zip',
    size: zipStat.size,
    browser_download_url:
      'https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.99/labview-mcp.zip',
  }
  if (!omitZipDigest) {
    zipAsset.digest = zipDigestOverride ?? `sha256:${zipSha256}`
  }
  const assets = [zipAsset]
  if (includeManifestAsset) {
    assets.push({
      name: 'labview-mcp.manifest.sha256',
      size: manifestStat.size,
      digest: `sha256:${manifestSha256}`,
      browser_download_url:
        'https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.99/labview-mcp.manifest.sha256',
    })
  }

  const releaseJsonPath = path.join(root, 'release.json')
  await writeFile(
    releaseJsonPath,
    `${JSON.stringify({ tag_name: 'v3.1.99', assets }, null, 2)}\n`,
  )

  return {
    root,
    releaseDirectory,
    zipPath,
    manifestPath,
    releaseJsonPath,
    fileCount: Object.keys(files).length,
    zipSha256,
    zipSize: zipStat.size,
  }
}

/** True when the path exists. */
async function exists(targetPath) {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** List `.tgz` files directly inside a directory. */
async function listTarballs(directory) {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith('.tgz'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

/** List package-relative file entries of a tarball. */
async function listTarballEntries(tarballPath) {
  const output = await runTar(['-tf', tarballPath])
  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/^package\//, ''))
    .filter((line) => line.length > 0 && !line.endsWith('/'))
}

test('a good fixture produces both tarballs and a complete binary package', async () => {
  const fixture = await createFixture()
  const outDir = path.join(fixture.root, 'dist')

  const summary = await runRelease({
    releaseJsonPath: fixture.releaseJsonPath,
    archivePath: fixture.zipPath,
    manifestPath: fixture.manifestPath,
    outDir,
    publishMode: 'dry-run',
    environment: {},
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.release.tag, 'v3.1.99')
  assert.equal(summary.binary.version, '3.1.99')
  assert.equal(summary.plugin.version, '1.1.0')
  assert.equal(summary.plugin.packageName, 'dsh-labview-mcp')
  assert.equal(summary.expectedFileCount, fixture.fileCount)
  assert.equal(summary.downloads.zip.source, 'local')
  assert.equal(summary.downloads.manifest.source, 'local')
  assert.equal(summary.binary.manifestGenerated, false)

  assert.equal(await exists(summary.binary.tarballPath), true)
  assert.equal(await exists(summary.plugin.tarballPath), true)
  assert.ok(summary.binary.tarballBytes > 0)
  assert.ok(summary.plugin.tarballBytes > 0)
  assert.match(path.basename(summary.binary.tarballPath), /^dsh-labview-mcp-win32-x64-3\.1\.99\.tgz$/)
  assert.match(path.basename(summary.plugin.tarballPath), /^dsh-labview-mcp-1\.1\.0\.tgz$/)

  const binaryEntries = await listTarballEntries(summary.binary.tarballPath)
  for (const required of [
    'runtime/bin/LabVIEWMCP.exe',
    'VERSION.txt',
    'labview-mcp.manifest.sha256',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
  ]) {
    assert.ok(binaryEntries.includes(required), `binary tarball is missing ${required}`)
  }
  assert.ok(binaryEntries.some((entry) => entry.startsWith('runtime/')))

  const binaryPublishedPaths = summary.binary.publishDryRun.files.map((file) => file.path)
  for (const required of [
    'runtime/bin/LabVIEWMCP.exe',
    'VERSION.txt',
    'labview-mcp.manifest.sha256',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
  ]) {
    assert.ok(
      binaryPublishedPaths.includes(required),
      `binary npm publish --dry-run is missing ${required}`,
    )
  }

  const pluginEntries = await listTarballEntries(summary.plugin.tarballPath)
  for (const required of [
    'index.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'LICENSE',
    'LICENSE-Zuehlke.txt',
    'LICENSE-pylabview.txt',
    'THIRD-PARTY-NOTICES.md',
    'docs/DETAIL.md',
    'docs/DETAIL.zh.md',
    'docs/migration-v1-to-v2.md',
    'docs/preview.svg',
  ]) {
    assert.ok(pluginEntries.includes(required), `plugin tarball is missing ${required}`)
  }
  assert.ok(pluginEntries.some((entry) => /^locale\/.+\.json$/.test(entry)))

  const pluginPublishedPaths = summary.plugin.publishDryRun.files.map((file) => file.path)
  for (const required of [
    'index.js',
    'cordis.patch.yml',
    'icon.svg',
    'README.md',
    'docs/DETAIL.md',
    'docs/DETAIL.zh.md',
    'docs/migration-v1-to-v2.md',
    'docs/preview.svg',
  ]) {
    assert.ok(pluginPublishedPaths.includes(required), `plugin dry-run is missing ${required}`)
  }
  assert.ok(pluginPublishedPaths.some((entry) => /^locale\/.+\.json$/.test(entry)))

  assert.equal(await exists(summary.reportPath), true)
  const report = JSON.parse(await readFile(summary.reportPath, 'utf8'))
  assert.equal(report.binary.tarballPath, summary.binary.tarballPath)
  assert.ok(report.binary.publishDryRun.files.length >= 6)
  assert.ok(report.plugin.publishDryRun.files.length >= 4)

  console.log(
    `fixture tarballs: ${path.basename(summary.binary.tarballPath)} `
    + `(${summary.binary.tarballBytes} bytes), `
    + `${path.basename(summary.plugin.tarballPath)} `
    + `(${summary.plugin.tarballBytes} bytes)`,
  )
})

test('a release JSON without a manifest asset builds with a generated manifest', async () => {
  const fixture = await createFixture({ includeManifestAsset: false })
  const outDir = path.join(fixture.root, 'dist')

  const summary = await runRelease({
    releaseJsonPath: fixture.releaseJsonPath,
    archivePath: fixture.zipPath,
    outDir,
    publishMode: 'dry-run',
    environment: {},
  })

  assert.equal(summary.ok, true)
  assert.equal(summary.release.manifestAsset, null)
  assert.equal(summary.downloads.manifest, null)
  assert.equal(summary.expectedFileCount, null)
  assert.equal(summary.binary.manifestGenerated, true)
  assert.equal(summary.binary.runtimeFileCount, fixture.fileCount)

  const binaryEntries = await listTarballEntries(summary.binary.tarballPath)
  assert.ok(binaryEntries.includes('labview-mcp.manifest.sha256'))

  const report = JSON.parse(await readFile(summary.reportPath, 'utf8'))
  assert.equal(report.release.manifestAsset, null)
  assert.equal(report.binary.manifestGenerated, true)
})

test('the plugin publish cooldown requires a 24-hour-old binary version', async () => {
  const publishedAt = Date.parse('2026-11-22T12:00:00.000Z')
  const fetchImpl = async (url) => {
    assert.match(url, /dsh-labview-mcp-win32-x64$/)
    return new Response(JSON.stringify({
      name: 'dsh-labview-mcp-win32-x64',
      time: { '3.1.0': new Date(publishedAt).toISOString() },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }

  await assert.rejects(
    checkPublishCooldown({
      version: '3.1.0',
      now: publishedAt + 23 * 60 * 60 * 1000,
      fetchImpl,
    }),
    /less than 24 hours[\s\S]*--skip-publish-cooldown/,
  )

  const passed = await checkPublishCooldown({
    version: '3.1.0',
    now: publishedAt + 24 * 60 * 60 * 1000,
    fetchImpl,
  })
  assert.equal(passed.version, '3.1.0')
  assert.equal(passed.packageName, 'dsh-labview-mcp-win32-x64')
  assert.equal(passed.ageMs, 24 * 60 * 60 * 1000)
})

test('the plugin publish cooldown refuses an unpublished or future version', async () => {
  const fetchImpl = async () => new Response(
    JSON.stringify({ name: 'dsh-labview-mcp-win32-x64', time: {} }),
    { status: 200 },
  )
  await assert.rejects(
    checkPublishCooldown({ version: '3.1.0', now: Date.now(), fetchImpl }),
    /no publish time/i,
  )

  const futureFetch = async () => new Response(
    JSON.stringify({ time: { '3.1.0': '2026-11-24T00:00:00.000Z' } }),
    { status: 200 },
  )
  await assert.rejects(
    checkPublishCooldown({
      version: '3.1.0',
      now: Date.parse('2026-11-23T00:00:00.000Z'),
      fetchImpl: futureFetch,
    }),
    /in the future/i,
  )
})

test('a checksum mismatch refuses and leaves no package tarball', async () => {
  const fixture = await createFixture({ zipDigestOverride: `sha256:${'0'.repeat(64)}` })
  const outDir = path.join(fixture.root, 'dist')

  await assert.rejects(
    runRelease({
      releaseJsonPath: fixture.releaseJsonPath,
      archivePath: fixture.zipPath,
      manifestPath: fixture.manifestPath,
      outDir,
      publishMode: 'dry-run',
      environment: {},
    }),
    /SHA-256 mismatch/i,
  )
  assert.deepEqual(await listTarballs(outDir), [])

  // The CLI must exit non-zero for the same failure.
  const cli = await runReleaseCli([
    '--release-json', fixture.releaseJsonPath,
    '--archive', fixture.zipPath,
    '--manifest', fixture.manifestPath,
    '--out', outDir,
  ])
  assert.equal(cli.code, 1)
  assert.match(cli.stderr, /SHA-256 mismatch/i)
  assert.deepEqual(await listTarballs(outDir), [])
})

test('release JSON without an asset digest is refused', async () => {
  const fixture = await createFixture({ omitZipDigest: true })
  await assert.rejects(
    runRelease({
      releaseJsonPath: fixture.releaseJsonPath,
      archivePath: fixture.zipPath,
      manifestPath: fixture.manifestPath,
      outDir: path.join(fixture.root, 'dist'),
      environment: {},
    }),
    /no sha256: digest/i,
  )
})

test('a zip without bin/LabVIEWMCP.exe is refused', async () => {
  const fixture = await createFixture({ omitExecutable: true })
  const outDir = path.join(fixture.root, 'dist')

  await assert.rejects(
    runRelease({
      releaseJsonPath: fixture.releaseJsonPath,
      archivePath: fixture.zipPath,
      manifestPath: fixture.manifestPath,
      outDir,
      publishMode: 'dry-run',
      environment: {},
    }),
    /missing bin\/LabVIEWMCP\.exe/i,
  )
  assert.deepEqual(await listTarballs(outDir), [])
})

test('publish mode without NPM_TOKEN fails clearly before building', async () => {
  const fixture = await createFixture()
  const publishOut = path.join(fixture.root, 'dist-publish')

  await assert.rejects(
    runRelease({
      releaseJsonPath: fixture.releaseJsonPath,
      archivePath: fixture.zipPath,
      manifestPath: fixture.manifestPath,
      outDir: publishOut,
      publishMode: 'binary',
      environment: {},
    }),
    /NPM_TOKEN is required/i,
  )
  assert.deepEqual(await listTarballs(publishOut), [])
})

test('malformed release JSON is refused', async () => {
  const root = await makeTemporaryDirectory()
  const releaseJsonPath = path.join(root, 'release.json')
  await writeFile(releaseJsonPath, '{ not json\n')

  await assert.rejects(
    runRelease({ releaseJsonPath, outDir: path.join(root, 'dist'), environment: {} }),
    /release JSON is malformed/i,
  )
})

test('a bad release tag is refused', async () => {
  const root = await makeTemporaryDirectory()
  const releaseJsonPath = path.join(root, 'release.json')
  await writeFile(releaseJsonPath, JSON.stringify({ tag_name: 'release-3.1', assets: [] }))

  await assert.rejects(
    runRelease({ releaseJsonPath, outDir: path.join(root, 'dist'), environment: {} }),
    /not a valid version tag/i,
  )
})

test('a missing fixed asset is refused', async () => {
  const root = await makeTemporaryDirectory()
  const releaseJsonPath = path.join(root, 'release.json')
  await writeFile(
    releaseJsonPath,
    JSON.stringify({
      tag_name: 'v3.1.0',
      assets: [
        {
          name: 'labview-mcp-v3.1.0.zip',
          size: 10,
          digest: `sha256:${'1'.repeat(64)}`,
        },
      ],
    }),
  )

  await assert.rejects(
    runRelease({ releaseJsonPath, outDir: path.join(root, 'dist'), environment: {} }),
    /no asset named labview-mcp\.zip/i,
  )
})

test('mirror download skips a bad candidate and reports the working mirror', async () => {
  const root = await makeTemporaryDirectory()
  const destinationPath = path.join(root, 'manifest.sha256')
  const expected = Buffer.from('0123456789abcdef\n')
  const requestedUrls = []
  const fetchImpl = async (url) => {
    requestedUrls.push(url)
    if (url.startsWith('https://ghfast.top/')) {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }
    if (url.startsWith('https://gh-proxy.com/')) {
      return new Response(expected, { status: 200 })
    }
    // GitHub direct returns a body with the wrong size.
    return new Response(Buffer.from('wrong'), { status: 200 })
  }

  const result = await downloadVerifiedAsset({
    asset: {
      name: 'labview-mcp.manifest.sha256',
      size: expected.length,
      sha256: sha256(expected),
      url: 'https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.0/labview-mcp.manifest.sha256',
    },
    destinationPath,
    mirrors: DEFAULT_MIRRORS,
    timeoutMs: 1000,
    fetchImpl,
    label: 'test manifest',
  })

  assert.equal(result.source, 'gh-proxy.com')
  assert.equal(result.bytes, expected.length)
  assert.deepEqual(requestedUrls, [
    'https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.0/labview-mcp.manifest.sha256',
    'https://ghfast.top/https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.0/labview-mcp.manifest.sha256',
    'https://gh-proxy.com/https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.0/labview-mcp.manifest.sha256',
  ])
  assert.deepEqual(await readFile(destinationPath), expected)
})

test('mirror download rejects every checksum-mismatched candidate', async () => {
  const root = await makeTemporaryDirectory()
  const destinationPath = path.join(root, 'manifest.sha256')
  const fetchImpl = async () => new Response(Buffer.from('wrong bytes'), { status: 200 })

  await assert.rejects(
    downloadVerifiedAsset({
      asset: {
        name: 'labview-mcp.manifest.sha256',
        size: 'wrong bytes'.length,
        sha256: '0'.repeat(64),
        url: 'https://github.com/Zuehlke/labview-mcp/releases/download/v3.1.0/labview-mcp.manifest.sha256',
      },
      destinationPath,
      mirrors: DEFAULT_MIRRORS,
      timeoutMs: 1000,
      fetchImpl,
      label: 'test manifest',
    }),
    /from any mirror[\s\S]*SHA-256 mismatch/i,
  )
  assert.equal(await exists(destinationPath), false)
})

test('readRegistryVersion requires the exact version and its tarball', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET' })
    if (String(url).endsWith('/dsh-labview-mcp-win32-x64')) {
      return new Response(JSON.stringify({
        versions: { '3.1.0': { dist: { tarball: 'https://registry.npmjs.org/dsh-labview-mcp-win32-x64/-/x.tgz' } } },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(null, { status: 200 })
  }

  const found = await readRegistryVersion({
    packageName: 'dsh-labview-mcp-win32-x64',
    version: '3.1.0',
    fetchImpl,
  })
  assert.equal(found.found, true)
  assert.equal(found.registryUrl, 'https://registry.npmjs.org')
  assert.equal(calls.at(-1).method, 'HEAD')

  const missing = await readRegistryVersion({
    packageName: 'dsh-labview-mcp-win32-x64',
    version: '3.2.0',
    fetchImpl,
  })
  assert.equal(missing.found, false)
  assert.match(missing.reason, /lists no dsh-labview-mcp-win32-x64@3\.2\.0/)
})

test('requestMirrorSync asks the mirror to pull the package upstream', async () => {
  let seen
  const result = await requestMirrorSync({
    packageName: 'dsh-labview-mcp-win32-x64',
    fetchImpl: async (url, init) => {
      seen = { url: String(url), method: init?.method }
      return new Response(null, { status: 200 })
    },
  })

  assert.equal(result.ok, true)
  assert.equal(seen.method, 'PUT')
  assert.match(seen.url, /^https:\/\/registry-direct\.npmmirror\.com\/dsh-labview-mcp-win32-x64\/sync\?sync_upstream=true$/)
  assert.equal(NPMMIRROR_REGISTRY, 'https://registry.npmmirror.com')
})

test('waitForRegistryVersion polls a stale mirror and syncs it first', async () => {
  let metadataCalls = 0
  const fetchImpl = async (url, init) => {
    const target = String(url)
    if (target.includes('/sync?')) return new Response(null, { status: 200 })
    if (init?.method === 'HEAD') return new Response(null, { status: 200 })
    metadataCalls += 1
    const versions = metadataCalls < 3
      ? {}
      : { '3.1.0': { dist: { tarball: 'https://registry.npmmirror.com/dsh-labview-mcp-win32-x64/-/x.tgz' } } }
    return new Response(JSON.stringify({ versions }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  const result = await waitForRegistryVersion({
    packageName: 'dsh-labview-mcp-win32-x64',
    version: '3.1.0',
    registryUrl: NPMMIRROR_REGISTRY,
    attempts: 3,
    intervalMs: 1,
    sleep: async () => {},
    sync: true,
    fetchImpl,
  })

  assert.equal(result.attempts, 3)
  assert.equal(result.sync.ok, true)
})

test('waitForRegistryVersion refuses a mirror that never serves the version', async () => {
  await assert.rejects(
    waitForRegistryVersion({
      packageName: 'dsh-labview-mcp-win32-x64',
      version: '3.1.0',
      registryUrl: NPMMIRROR_REGISTRY,
      attempts: 2,
      intervalMs: 0,
      sleep: async () => {},
      sync: true,
      fetchImpl: async () => new Response(JSON.stringify({ versions: {} }), { status: 200 }),
    }),
    /not available from https:\/\/registry\.npmmirror\.com[\s\S]*registry-direct\.npmmirror\.com[\s\S]*sync\?sync_upstream=true/,
  )
})

test('skipping the publish cooldown asks for an explicit environment override', async () => {
  const fixture = await createFixture()
  await assert.rejects(
    runRelease({
      releaseJsonPath: fixture.releaseJsonPath,
      archivePath: fixture.zipPath,
      outDir: path.join(fixture.root, 'dist'),
      publishMode: 'plugin',
      skipPublishCooldown: true,
      environment: { NPM_TOKEN: 'token' },
    }),
    /DSH_RELEASE_ALLOW_EARLY_PLUGIN=1/,
  )
})
