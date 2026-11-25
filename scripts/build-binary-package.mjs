#!/usr/bin/env node
/**
 * Build the `dsh-labview-mcp-win32-x64` npm binary package from a verified
 * upstream release zip.
 *
 * The package layout is:
 *
 *   dsh-labview-mcp-win32-x64/
 *     package.json
 *     VERSION.txt
 *     labview-mcp.manifest.sha256
 *     LICENSE
 *     THIRD-PARTY-NOTICES.md
 *     runtime/                 full upstream release tree (bin/, agents/, hooks/, ...)
 *
 * The builder is intentionally strict: it verifies the zip size/SHA-256 before
 * extracting, verifies the staged runtime against the upstream manifest, and
 * refuses to write a package when anything is missing or unexpected. Building
 * happens in a staging directory beside the output; the output path is only
 * replaced after every check has passed.
 *
 * CLI:
 *   node scripts/build-binary-package.mjs --zip <path> --version <semver> [options]
 *
 * Exported API (used by the release script):
 *   buildBinaryPackage({ zipPath, version, outDir, expectedSha256, expectedSize, ... })
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
const ASSETS_DIRECTORY = path.join(SCRIPT_DIRECTORY, 'assets')

export const DEFAULT_OUT_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  'dist',
  'dsh-labview-mcp-win32-x64',
)
export const DEFAULT_PACK_DESTINATION = path.join(REPOSITORY_ROOT, 'dist')

/**
 * The upstream v3.1.9 release contains 5,583 files (including the 65 Python
 * bytecode files that upstream deliberately ships in `__pycache__`). The
 * release script for a future upstream tag passes that tag's own manifest
 * count; this default makes the documented v3.1.9 build fail on any drift.
 */
export const DEFAULT_EXPECTED_RUNTIME_FILE_COUNT = 5583

const PACKAGE_NAME = 'dsh-labview-mcp-win32-x64'
const PACKAGE_DESCRIPTION =
  "Zuehlke's LabVIEW MCP runtime (Windows x64) for the unofficial dsh-labview-mcp DSH plugin"
const RELEASE_EXECUTABLE = 'bin/LabVIEWMCP.exe'
const RELEASE_VERSION_FILE = 'VERSION.txt'
const MANIFEST_FILE_NAME = 'labview-mcp.manifest.sha256'
const RELEASE_REQUIRED_DIRECTORIES = Object.freeze([
  'bin/pylabview',
  'bin/scripts',
  'bin/docs',
])

const CACHE_DIRECTORY_NAMES = new Set(['__pycache__', '.labviewmcp'])
const CACHE_FILE_NAMES = new Set(['.DS_Store', 'Thumbs.db'])
const CACHE_FILE_EXTENSIONS = new Set(['.pyc', '.pyo', '.log', '.tmp'])

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/
const MANIFEST_LINE_PATTERN = /^([0-9a-fA-F]{64}) {2}(.+)$/

/** Convert an unknown thrown value into a readable message. */
function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

/** True when the path exists and is a regular file. */
async function isFile(targetPath) {
  try {
    return (await stat(targetPath)).isFile()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** True when the path exists and is a directory. */
async function isDirectory(targetPath) {
  try {
    return (await stat(targetPath)).isDirectory()
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false
    throw error
  }
}

/** SHA-256 of a file, streamed so the 89 MB executable does not sit in memory. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/** Run a child process and collect stdout/stderr. */
function runProcess(command, args, { cwd, timeoutMs = 15 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs} ms`))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }
      const detail = stderr.trim() || stdout.trim()
      reject(new Error(`${path.basename(command)} exited with code ${code}${detail ? `: ${detail}` : ''}`))
    })
  })
}

/** Path of the platform tar executable (`tar.exe` on Windows). */
function resolveTarExecutable() {
  if (process.platform === 'win32' && process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, 'System32', 'tar.exe')
  }
  return 'tar'
}

/** Recursively list every file under `root`, with `/`-separated relative paths. */
async function collectFiles(root) {
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

  await walk(root, '')
  return files
}

/** Recursively list every directory under `root`, with `/`-separated relative paths. */
async function collectDirectories(root) {
  const directories = []

  async function walk(currentDirectory, prefix) {
    const entries = await readdir(currentDirectory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      directories.push(relativePath)
      await walk(path.join(currentDirectory, entry.name), relativePath)
    }
  }

  await walk(root, '')
  return directories
}

/** True when a relative path looks like a local cache artifact. */
function isCachePath(relativePath) {
  const parts = relativePath.split('/')
  if (parts.some((part) => CACHE_DIRECTORY_NAMES.has(part))) return true
  const baseName = parts.at(-1) ?? ''
  if (CACHE_FILE_NAMES.has(baseName)) return true
  return CACHE_FILE_EXTENSIONS.has(path.extname(baseName).toLowerCase())
}

/** Convert a manifest relative path into a native path under `root`. */
function manifestEntryFilePath(root, relativePath) {
  const normalized = path.normalize(relativePath)
  if (
    !relativePath
    || path.isAbsolute(normalized)
    || normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`manifest path is outside the release root: ${relativePath}`)
  }
  return path.join(root, normalized)
}

/**
 * Parse and validate one upstream manifest.
 * Format: `<64-hex sha256><two spaces><relative path>`, LF or CRLF.
 * @returns {Promise<Map<string, string>>} relative path -> lowercase digest
 */
async function readManifest(manifestPath) {
  const text = await readFile(manifestPath, 'utf8')
  const entries = new Map()

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue
    const match = MANIFEST_LINE_PATTERN.exec(line)
    if (!match) {
      throw new Error(`manifest line ${index + 1} is malformed: ${line.slice(0, 120)}`)
    }
    const relativePath = match[2].trim().replaceAll('\\', '/')
    const digest = match[1].toLowerCase()
    if (entries.has(relativePath)) {
      throw new Error(`manifest lists ${relativePath} more than once`)
    }
    entries.set(relativePath, digest)
  }

  if (entries.size === 0) {
    throw new Error(`manifest is empty: ${manifestPath}`)
  }
  return entries
}

/**
 * Generate a manifest for a release tree that does not ship one.
 *
 * Only used when the release has no manifest asset; the generated file is
 * written into the package and verified like any other manifest.
 */
async function generateRuntimeManifest(runtimeRoot, manifestPath) {
  const files = await collectFiles(runtimeRoot)
  if (files.length === 0) {
    throw new Error(`cannot generate a manifest for an empty runtime: ${runtimeRoot}`)
  }
  const lines = []
  for (const relativePath of files) {
    const digest = await sha256File(path.join(runtimeRoot, ...relativePath.split('/')))
    lines.push(`${digest}  ${relativePath}`)
  }
  await writeFile(manifestPath, `${lines.join('\n')}\n`)
}

/**
 * Verify a runtime tree against the upstream manifest.
 *
 * Every manifest entry must exist with the recorded hash. Every file in the
 * tree must be listed (an extra file is drift). Cache-like files that are not
 * part of the verified upstream release are called out separately so a local
 * `__pycache__` left behind by a test run is easy to diagnose. Note that the
 * upstream v3.1.0 release itself ships 65 manifest-listed `.pyc` files; those
 * are legitimate release content and are allowed.
 *
 * @returns {Promise<{fileCount: number, manifestEntryCount: number, manifestListedCacheEntries: number, totalBytes: number}>}
 */
async function verifyRuntimeAgainstManifest(runtimeRoot, manifestPath) {
  const manifestEntries = await readManifest(manifestPath)
  const files = await collectFiles(runtimeRoot)
  const directories = await collectDirectories(runtimeRoot)
  const actualPaths = new Set(files)

  for (const relativePath of files) {
    if (!manifestEntries.has(relativePath) && isCachePath(relativePath)) {
      throw new Error(
        `runtime contains a local cache file that is not part of the verified release: ${relativePath}`,
      )
    }
  }

  for (const relativePath of files) {
    if (!manifestEntries.has(relativePath)) {
      throw new Error(`runtime contains a file that is not in the manifest: ${relativePath}`)
    }
  }

  for (const relativeDirectory of directories) {
    if (!CACHE_DIRECTORY_NAMES.has(path.posix.basename(relativeDirectory))) continue
    const prefix = `${relativeDirectory}/`
    if (![...manifestEntries.keys()].some((entry) => entry.startsWith(prefix))) {
      throw new Error(
        `runtime contains a cache directory that is not part of the verified release: ${relativeDirectory}`,
      )
    }
  }

  let manifestListedCacheEntries = 0
  let totalBytes = 0
  for (const [relativePath, expectedHash] of manifestEntries) {
    if (!actualPaths.has(relativePath)) {
      throw new Error(`manifest file is missing from the runtime: ${relativePath}`)
    }
    if (isCachePath(relativePath)) manifestListedCacheEntries += 1

    const filePath = manifestEntryFilePath(runtimeRoot, relativePath)
    const fileStat = await stat(filePath)
    totalBytes += fileStat.size
    const actualHash = await sha256File(filePath)
    if (actualHash !== expectedHash) {
      throw new Error(
        `checksum mismatch for ${relativePath}: expected ${expectedHash}, got ${actualHash}`,
      )
    }
  }

  return {
    fileCount: files.length,
    manifestEntryCount: manifestEntries.size,
    manifestListedCacheEntries,
    totalBytes,
  }
}

/**
 * Locate the manifest asset for a release.
 *
 * Order: a same-named file inside the extracted release tree (if upstream ever
 * starts shipping one), then an explicit `manifestPath`, then the release
 * asset downloaded beside the zip (`labview-mcp.manifest.sha256` or the
 * historical `manifest.sha256` name used by our scratch download).
 */
async function resolveManifestPath({ releaseRoot, zipPath, manifestPath }) {
  const inTree = path.join(releaseRoot, MANIFEST_FILE_NAME)
  if (await isFile(inTree)) return inTree

  if (manifestPath) {
    const explicitPath = path.resolve(manifestPath)
    if (!await isFile(explicitPath)) {
      throw new Error(`manifest file does not exist: ${explicitPath}`)
    }
    return explicitPath
  }

  const zipDirectory = path.dirname(path.resolve(zipPath))
  for (const candidateName of [MANIFEST_FILE_NAME, 'manifest.sha256']) {
    const candidatePath = path.join(zipDirectory, candidateName)
    if (await isFile(candidatePath)) return candidatePath
  }

  throw new Error(
    `manifest not found: expected ${MANIFEST_FILE_NAME} in the release tree, `
    + `an explicit --manifest path, or ${MANIFEST_FILE_NAME}/manifest.sha256 beside the zip`,
  )
}

/** Detect and unwrap a single top-level directory in an extracted archive. */
async function resolveReleaseRoot(extractDirectory) {
  const entries = await readdir(extractDirectory, { withFileTypes: true })
  if (entries.length === 1 && entries[0].isDirectory()) {
    const wrappedRoot = path.join(extractDirectory, entries[0].name)
    const hasReleaseLayout = await isFile(path.join(wrappedRoot, RELEASE_VERSION_FILE))
      || await isFile(path.join(wrappedRoot, RELEASE_EXECUTABLE))
    if (hasReleaseLayout && !await isFile(path.join(extractDirectory, RELEASE_VERSION_FILE))) {
      return wrappedRoot
    }
  }
  return extractDirectory
}

/** Read and validate the release `VERSION.txt`. */
async function readReleaseVersion(releaseRoot) {
  const versionFile = path.join(releaseRoot, RELEASE_VERSION_FILE)
  if (!await isFile(versionFile)) {
    throw new Error(`release tree is missing ${RELEASE_VERSION_FILE}`)
  }
  const text = await readFile(versionFile, 'utf8')
  const match = /^version:\s*(\S+)\s*$/m.exec(text)
  if (!match) {
    throw new Error(`${RELEASE_VERSION_FILE} has no "version:" line`)
  }
  return match[1]
}

/**
 * Parse the JSON emitted by `npm pack --json`.
 * @returns {object} the first (and normally only) pack report
 */
function parseNpmPackReport(stdout) {
  const text = stdout.trim()
  if (!text) throw new Error('npm pack printed no JSON report')
  let report
  try {
    report = JSON.parse(text)
  } catch {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end <= start) throw new Error('npm pack printed no JSON report')
    report = JSON.parse(text.slice(start, end + 1))
  }
  if (!Array.isArray(report) || report.length === 0) {
    throw new Error('npm pack report is empty')
  }
  return report[0]
}

/** Run `npm pack` in a built package directory and report the tarball. */
async function packPackage(packageDirectory, packDestination) {
  await mkdir(packDestination, { recursive: true })
  const npmArguments = ['pack', '--json', '--pack-destination', packDestination]
  const result = process.platform === 'win32'
    ? await runProcess(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'npm', ...npmArguments],
      { cwd: packageDirectory },
    )
    : await runProcess('npm', npmArguments, { cwd: packageDirectory })

  const report = parseNpmPackReport(result.stdout)
  const tarballPath = path.resolve(packDestination, report.filename)
  const tarballStat = await stat(tarballPath)
  return {
    tarballPath,
    tarballBytes: tarballStat.size,
    tarballEntryCount: Array.isArray(report.files) ? report.files.length : null,
    tarballSha256: await sha256File(tarballPath),
  }
}

/**
 * Build the binary package.
 *
 * @param {object} options
 * @param {string} options.zipPath absolute path to the upstream `labview-mcp.zip`.
 * @param {string} options.version upstream release version written into `package.json`.
 * @param {string} [options.outDir] package output directory.
 * @param {string} [options.expectedSha256] required SHA-256 of the zip.
 * @param {number|string} [options.expectedSize] required byte size of the zip.
 * @param {string} [options.manifestPath] manifest asset when the release tree lacks one.
 * @param {boolean} [options.generateManifest] generate a manifest when the release has none.
 * @param {number|string|null} [options.expectedFileCount] required runtime file count.
 * @param {boolean} [options.pack] run `npm pack` after building (default true).
 * @param {string} [options.packDestination] where `npm pack` writes the tarball.
 * @param {string} [options.assetsDirectory] directory holding the license/notice assets.
 * @returns {Promise<object>} build summary including file counts and tarball details.
 */
export async function buildBinaryPackage({
  zipPath,
  version,
  outDir = DEFAULT_OUT_DIRECTORY,
  expectedSha256,
  expectedSize,
  manifestPath,
  generateManifest = false,
  expectedFileCount = DEFAULT_EXPECTED_RUNTIME_FILE_COUNT,
  pack = true,
  packDestination = DEFAULT_PACK_DESTINATION,
  assetsDirectory = ASSETS_DIRECTORY,
} = {}) {
  if (!zipPath) throw new Error('zipPath is required')
  if (!version) throw new Error('version is required')
  if (!SEMVER_PATTERN.test(String(version))) {
    throw new Error(`version is not a valid semantic version: ${version}`)
  }

  const resolvedZipPath = path.resolve(zipPath)
  const resolvedOutDir = path.resolve(outDir)
  const resolvedAssetsDirectory = path.resolve(assetsDirectory)

  if (!await isFile(resolvedZipPath)) {
    throw new Error(`zip file does not exist: ${resolvedZipPath}`)
  }
  if (expectedSha256 !== undefined && expectedSha256 !== null && !SHA256_PATTERN.test(expectedSha256)) {
    throw new Error(`expected SHA-256 must be 64 hex characters: ${expectedSha256}`)
  }

  // ---- 1. Verify the archive before extracting anything -------------------
  const zipStat = await stat(resolvedZipPath)
  if (expectedSize !== undefined && expectedSize !== null && Number(expectedSize) !== zipStat.size) {
    throw new Error(`zip size mismatch: expected ${expectedSize} bytes, got ${zipStat.size}`)
  }
  if (expectedSha256 !== undefined && expectedSha256 !== null) {
    const actualSha256 = await sha256File(resolvedZipPath)
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new Error(
        `zip SHA-256 mismatch: expected ${expectedSha256.toLowerCase()}, got ${actualSha256}`,
      )
    }
  }

  // ---- 2. Extract and stage the package beside the output directory ------
  await mkdir(path.dirname(resolvedOutDir), { recursive: true })
  const stagingDirectory = await mkdtemp(
    path.join(path.dirname(resolvedOutDir), '.dsh-labview-mcp-build-'),
  )
  const extractDirectory = await mkdtemp(path.join(os.tmpdir(), 'dsh-labview-mcp-extract-'))

  try {
    await runProcess(
      resolveTarExecutable(),
      ['-xf', resolvedZipPath, '-C', extractDirectory],
    )

    const releaseRoot = await resolveReleaseRoot(extractDirectory)
    if (!await isFile(path.join(releaseRoot, RELEASE_EXECUTABLE))) {
      throw new Error(`release tree is missing ${RELEASE_EXECUTABLE}`)
    }
    for (const relativeDirectory of RELEASE_REQUIRED_DIRECTORIES) {
      const directoryPath = path.join(releaseRoot, ...relativeDirectory.split('/'))
      if (!await isDirectory(directoryPath)) {
        throw new Error(`release tree is missing required directory ${relativeDirectory}`)
      }
    }
    const releaseVersion = await readReleaseVersion(releaseRoot)
    if (releaseVersion !== String(version)) {
      throw new Error(
        `release VERSION.txt says ${releaseVersion}, but --version is ${version}`,
      )
    }

    let resolvedManifestPath = null
    let manifestGenerated = false
    if (generateManifest) {
      try {
        resolvedManifestPath = await resolveManifestPath({
          releaseRoot,
          zipPath: resolvedZipPath,
          manifestPath,
        })
      } catch (error) {
        if (!/manifest not found/i.test(errorMessage(error))) throw error
        manifestGenerated = true
      }
    } else {
      resolvedManifestPath = await resolveManifestPath({
        releaseRoot,
        zipPath: resolvedZipPath,
        manifestPath,
      })
    }

    const runtimeDirectory = path.join(stagingDirectory, 'runtime')
    await cp(releaseRoot, runtimeDirectory, { recursive: true })

    // Package-root copies live beside the runtime/ directory. The runtime tree
    // itself stays a byte-for-byte copy of the upstream release.
    await copyFile(
      path.join(releaseRoot, RELEASE_VERSION_FILE),
      path.join(stagingDirectory, RELEASE_VERSION_FILE),
    )
    const stagedManifestPath = path.join(stagingDirectory, MANIFEST_FILE_NAME)
    if (manifestGenerated) {
      await generateRuntimeManifest(runtimeDirectory, stagedManifestPath)
    } else {
      await copyFile(resolvedManifestPath, stagedManifestPath)
    }
    await copyFile(
      path.join(resolvedAssetsDirectory, 'LICENSE-Zuehlke.txt'),
      path.join(stagingDirectory, 'LICENSE'),
    )
    await copyFile(
      path.join(resolvedAssetsDirectory, 'THIRD-PARTY-NOTICES.md'),
      path.join(stagingDirectory, 'THIRD-PARTY-NOTICES.md'),
    )

    // ---- 3. Verify the staged runtime against the manifest ---------------
    const verification = await verifyRuntimeAgainstManifest(
      runtimeDirectory,
      path.join(stagingDirectory, MANIFEST_FILE_NAME),
    )
    if (verification.fileCount !== verification.manifestEntryCount) {
      throw new Error(
        `runtime file count ${verification.fileCount} differs from manifest count `
        + `${verification.manifestEntryCount}`,
      )
    }
    if (expectedFileCount !== undefined && expectedFileCount !== null
      && verification.fileCount !== Number(expectedFileCount)) {
      throw new Error(
        `runtime file count ${verification.fileCount} differs from expected `
        + `${expectedFileCount}`,
      )
    }

    // ---- 4. Write package metadata ---------------------------------------
    const packageMetadata = {
      name: PACKAGE_NAME,
      version: String(version),
      description: PACKAGE_DESCRIPTION,
      license: 'MIT',
      os: ['win32'],
      cpu: ['x64'],
      files: [
        'runtime',
        'VERSION.txt',
        'labview-mcp.manifest.sha256',
        'LICENSE',
        'THIRD-PARTY-NOTICES.md',
      ],
    }
    await writeFile(
      path.join(stagingDirectory, 'package.json'),
      `${JSON.stringify(packageMetadata, null, 2)}\n`,
    )

    // ---- 5. Publish the finished package atomically ----------------------
    await rm(resolvedOutDir, { recursive: true, force: true })
    await rename(stagingDirectory, resolvedOutDir)

    const summary = {
      ok: true,
      packageName: PACKAGE_NAME,
      version: String(version),
      outDir: resolvedOutDir,
      packageJsonPath: path.join(resolvedOutDir, 'package.json'),
      runtimeDir: path.join(resolvedOutDir, 'runtime'),
      runtimeFileCount: verification.fileCount,
      manifestEntryCount: verification.manifestEntryCount,
      manifestListedCacheFiles: verification.manifestListedCacheEntries,
      runtimeBytes: verification.totalBytes,
      manifestPath: manifestGenerated
        ? path.join(resolvedOutDir, MANIFEST_FILE_NAME)
        : resolvedManifestPath,
      manifestGenerated,
      tarballPath: null,
      tarballBytes: null,
      tarballEntryCount: null,
      tarballSha256: null,
    }

    if (pack) {
      Object.assign(summary, await packPackage(resolvedOutDir, path.resolve(packDestination)))
    }
    return summary
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {})
    await rm(extractDirectory, { recursive: true, force: true }).catch(() => {})
  }
}

const CLI_USAGE = `Usage:
  node scripts/build-binary-package.mjs --zip <path> --version <semver> [options]

Required:
  --zip <path>                 Upstream release zip (labview-mcp.zip)
  --version <semver>           Upstream release version, e.g. 3.1.0

Options:
  --out <dir>                  Package output directory (default: ${DEFAULT_OUT_DIRECTORY})
  --expected-sha256 <hex>      Refuse the zip unless its SHA-256 matches
  --expected-size <bytes>      Refuse the zip unless its size matches
  --manifest <path>            Manifest asset when the release tree does not ship one
  --generate-manifest          Generate a manifest when the release has none
  --expected-file-count <n>    Runtime file count (default: ${DEFAULT_EXPECTED_RUNTIME_FILE_COUNT})
  --pack-destination <dir>     Where npm pack writes the tarball (default: ${DEFAULT_PACK_DESTINATION})
  --no-pack                    Build the package without running npm pack
  --help                       Show this help
`

/** Parse the CLI arguments. */
function parseArguments(argv) {
  const options = { pack: true }
  const valueFlags = new Map([
    ['--zip', 'zipPath'],
    ['--version', 'version'],
    ['--out', 'outDir'],
    ['--expected-sha256', 'expectedSha256'],
    ['--expected-size', 'expectedSize'],
    ['--manifest', 'manifestPath'],
    ['--expected-file-count', 'expectedFileCount'],
    ['--pack-destination', 'packDestination'],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--no-pack') {
      options.pack = false
      continue
    }
    if (argument === '--generate-manifest') {
      options.generateManifest = true
      continue
    }

    const [flag, inlineValue] = argument.includes('=')
      ? argument.split(/=(.*)/s, 2)
      : [argument, undefined]
    const key = valueFlags.get(flag)
    if (!key) throw new Error(`unknown argument: ${argument}`)
    const value = inlineValue ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for ${flag}`)
    }
    if (inlineValue === undefined) index += 1
    options[key] = value
  }
  return options
}

/** CLI entry point. */
async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    console.error(`build-binary-package: ${errorMessage(error)}`)
    console.error(CLI_USAGE)
    process.exitCode = 2
    return
  }

  if (options.help) {
    console.log(CLI_USAGE)
    return
  }
  if (!options.zipPath || !options.version) {
    console.error('build-binary-package: --zip and --version are required')
    console.error(CLI_USAGE)
    process.exitCode = 2
    return
  }

  try {
    const summary = await buildBinaryPackage(options)
    console.log(JSON.stringify(summary, null, 2))
  } catch (error) {
    console.error(`build-binary-package: ${errorMessage(error)}`)
    process.exitCode = 1
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : ''
if (invokedPath === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2))
}
